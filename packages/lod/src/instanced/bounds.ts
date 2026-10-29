import { Box3, Matrix4, Sphere, Vector3 } from "three/webgpu";
import { FADE, DEMAND } from "../levels.js";
import { Dirty } from "./dirty.js";

// Cover float32 matrix products, distances and threshold arithmetic. Near a switch,
// uncertain blocks keep both levels and cannot reuse a previous GPU selection.
const ROUND = 1e-5;
const matrix = new Matrix4();
const point = new Vector3();
const extent = new Vector3();

interface Branch {
  geometry: Box3;
  centers: Box3;
  sphere: Sphere;
  smallest: number;
  largest: number;
  reach: number;
  solid: number;
  unsafe: boolean;
}

export interface BoundsView {
  eye: Vector3;
  scale: number;
  ortho: boolean;
  fades: boolean;
  forced: number | null;
}

/** Cached spatial blocks: instance edits refit leaves; moving views visit only blocks. */
export class Bounds {
  private readonly block: number;
  private readonly leaves: number;
  private readonly tree: Branch[];
  private readonly dirty: Dirty;
  private readonly radii: Float64Array;
  private readonly roundoff: Float64Array;
  private readonly unsafe: Uint8Array;
  private readonly levelBoxes: Box3[] = [];
  private token: object = {};
  private changed = false;
  private complete = true;
  private low = 0;
  private high = 0;
  private padding = 0;

  constructor(
    private readonly matrices: Float32Array,
    private readonly spheres: Float32Array,
    private readonly source: Sphere,
    readonly sphere: Sphere,
    draws: number,
    /** Radius enclosing every placed level about source.center. */
    private readonly geometry: { readonly radius: number } = source,
  ) {
    const count = matrices.length / 16;
    // Fine leaves avoid many empty draws in small, multipart crowds. Large crowds
    // retain bounded block traversal rather than inspecting every instance per view.
    this.block = count <= 4096 && draws >= 8 ? 1 : 64;
    this.leaves = 2 ** Math.ceil(Math.log2(Math.max(1, Math.ceil(count / this.block))));
    this.tree = Array.from({ length: this.leaves * 2 }, () => ({
      geometry: new Box3(),
      centers: new Box3(),
      sphere: new Sphere(),
      smallest: Infinity,
      largest: 0,
      reach: 0,
      solid: -1,
      unsafe: false,
    }));
    this.dirty = new Dirty(Math.ceil(count / this.block));
    this.radii = new Float64Array(count);
    this.roundoff = new Float64Array(count);
    this.unsafe = new Uint8Array(count);
  }

  /** Measure changed matrices, retaining the GPU's max-axis radius for LOD selection. */
  measure(start: number, end: number): void {
    const { center, radius } = this.source;
    for (let i = start; i < end; i++) {
      matrix.fromArray(this.matrices, i * 16);
      point
        .copy(center)
        .applyMatrix4(matrix)
        .toArray(this.spheres, i * 4);
      const axis = matrix.getMaxScaleOnAxis();
      this.spheres[i * 4 + 3] = radius * axis;
      this.radii[i] = this.geometry.radius * stretch(matrix);
      const e = matrix.elements;
      // Absolute terms also cover cancellation in the shader's transformed center.
      const terms = Math.max(
        Math.abs(e[0] * center.x) + Math.abs(e[4] * center.y) + Math.abs(e[8] * center.z) + Math.abs(e[12]),
        Math.abs(e[1] * center.x) + Math.abs(e[5] * center.y) + Math.abs(e[9] * center.z) + Math.abs(e[13]),
        Math.abs(e[2] * center.x) + Math.abs(e[6] * center.y) + Math.abs(e[10] * center.z) + Math.abs(e[14]),
        radius,
        this.geometry.radius,
      );
      this.roundoff[i] = ROUND * Math.sqrt(3) * terms;
      // WGSL length squares its inputs. Guard the intermediates, not only the final
      // screen height: infinity / infinity would select level zero, not the CPU tier.
      this.unsafe[i] = Number(unsafe(axis) || unsafe(radius) || terms > 1e15 || !Number.isFinite(terms));
      this.dirty.add(Math.floor(i / this.block));
    }
  }

  pad(padding: number): void {
    if (padding === this.padding) return;
    this.padding = padding;
    this.dirty.all();
  }

  /** Refit only edited leaves and their ancestors. No instance scan on view changes. */
  refit(): void {
    if (this.dirty.empty) return;
    this.dirty.drain((start, end) => {
      for (let block = start; block < end; block++) {
        this.leaf(at(this.tree, this.leaves + block), block);
      }
      // Join each affected parent once per depth, making a full edit linear in the
      // tree size even when multipart crowds use one leaf per instance.
      let first = Math.floor((this.leaves + start) / 2);
      let last = Math.ceil((this.leaves + end) / 2);
      while (first > 0) {
        for (let index = first; index < last; index++) this.join(index);
        first = Math.floor(first / 2);
        last = Math.ceil(last / 2);
      }
    });
    enclosing(at(this.tree, 1).geometry, this.sphere);
  }

  private leaf(node: Branch, block: number): void {
    node.geometry.makeEmpty();
    node.centers.makeEmpty();
    node.smallest = Infinity;
    node.largest = node.reach = 0;
    node.solid = -1;
    node.unsafe = false;
    const end = Math.min((block + 1) * this.block, this.radii.length);
    for (let i = block * this.block; i < end; i++) {
      const radius = at(this.spheres, i * 4 + 3);
      if (radius === 0 && !at(this.unsafe, i)) continue;
      node.unsafe ||= Boolean(at(this.unsafe, i));
      const roundoff = at(this.roundoff, i);
      const reach = at(this.radii, i) * (1 + this.padding) + roundoff;
      point.fromArray(this.spheres, i * 4);
      expand(node.centers, point, roundoff);
      expand(node.geometry, point, reach);
      node.smallest = Math.min(node.smallest, radius);
      node.largest = Math.max(node.largest, radius);
      node.reach = Math.max(node.reach, reach);
    }
    enclosing(node.centers, node.sphere);
  }

  private join(index: number): void {
    const node = at(this.tree, index);
    const a = at(this.tree, index * 2);
    const b = at(this.tree, index * 2 + 1);
    node.geometry.copy(a.geometry).union(b.geometry);
    node.centers.copy(a.centers).union(b.centers);
    enclosing(node.centers, node.sphere);
    node.smallest = Math.min(a.smallest, b.smallest);
    node.largest = Math.max(a.largest, b.largest);
    node.reach = Math.max(a.reach, b.reach);
    node.unsafe = a.unsafe || b.unsafe;
    node.solid = -1;
  }

  /** Level bounds plus a token only when every block has an unchanged solid choice. */
  select(levels: readonly { maxPixels: number }[], view: BoundsView, reaches: Sphere[], measured: boolean, root: Matrix4): object | undefined {
    while (this.levelBoxes.length < levels.length) this.levelBoxes.push(new Box3());
    for (const box of this.levelBoxes) box.makeEmpty();
    this.complete = measured;
    this.changed = false;
    if (!this.sphere.isEmpty()) {
      if (measured) this.visit(1, levels, view);
      else for (const box of this.levelBoxes) box.copy(at(this.tree, 1).geometry);
    }
    this.enclose(levels, view, reaches, root, measured, 1);
    if (!this.complete) return undefined;
    if (this.changed) this.token = {};
    return this.token;
  }

  /** Ahead-of-view demand without changing solid selections or their reuse token. */
  demand(levels: readonly { maxPixels: number }[], view: BoundsView, reaches: Sphere[], root: Matrix4): void {
    while (this.levelBoxes.length < levels.length) this.levelBoxes.push(new Box3());
    for (const box of this.levelBoxes) box.makeEmpty();
    this.gather(1, levels, view);
    this.enclose(levels, view, reaches, root, true, DEMAND);
  }

  private gather(index: number, levels: readonly { maxPixels: number }[], view: BoundsView): void {
    const node = at(this.tree, index);
    if (node.geometry.isEmpty()) return;
    this.interval(node, view);
    const high = this.high / DEMAND;
    let finest = view.forced ?? (high === Infinity ? 0 : fitting(levels, high));
    const coarsest = view.forced ?? fitting(levels, this.low);
    if (view.fades && finest > 0 && high >= at(levels, finest).maxPixels * (1 - FADE) * (1 - ROUND)) finest--;
    if (finest !== coarsest && index < this.leaves) {
      this.gather(index * 2, levels, view);
      this.gather(index * 2 + 1, levels, view);
      return;
    }
    for (let level = finest; level <= coarsest; level++) at(this.levelBoxes, level).union(node.geometry);
  }

  private enclose(levels: readonly { maxPixels: number }[], view: BoundsView, reaches: Sphere[], root: Matrix4, measured: boolean, margin: number): void {
    const top = at(this.tree, 1);
    const axis = root.getMaxScaleOnAxis();
    // Three transforms a culling sphere by max-axis scale, which underbounds shear.
    const dilation = axis > 0 ? stretch(root) / axis : 1;
    reaches.forEach((sphere, level) => {
      enclosing(at(this.levelBoxes, level), sphere);
      const next = levels[level + 1];
      if (measured && !top.unsafe && !unsafe(view.scale) && view.eye.length() < 1e15 && !sphere.isEmpty() && !view.ortho && view.forced === null && next) {
        const threshold = next.maxPixels * (view.fades ? 1 - FADE : 1) * margin;
        const radius = (2 * top.largest * view.scale * (1 + ROUND * 4)) / threshold + top.reach + view.eye.length() * ROUND;
        if (radius < sphere.radius) sphere.set(view.eye, radius);
      }
      if (!sphere.isEmpty()) sphere.radius *= dilation;
    });
  }

  private visit(index: number, levels: readonly { maxPixels: number }[], view: BoundsView): void {
    const node = at(this.tree, index);
    if (node.geometry.isEmpty()) return;
    this.interval(node, view);
    const low = this.low;
    const high = this.high;
    // Infinity marks an unsafe float32 interval; even legal infinite thresholds
    // cannot exclude the source when the GPU's height may be NaN.
    let finest = view.forced ?? (high === Infinity ? 0 : fitting(levels, high));
    const coarsest = view.forced ?? fitting(levels, low);
    if (view.fades && finest > 0 && high >= at(levels, finest).maxPixels * (1 - FADE) * (1 - ROUND)) finest--;
    if (finest === coarsest) {
      this.changed ||= node.solid !== finest;
      node.solid = finest;
      at(this.levelBoxes, finest).union(node.geometry);
      return;
    }
    // Descendants may hold a proof from an older split; never reuse that after the
    // whole branch was last selected as one solid level.
    this.changed ||= node.solid !== -1;
    node.solid = -1;
    if (index < this.leaves) {
      this.visit(index * 2, levels, view);
      this.visit(index * 2 + 1, levels, view);
      return;
    }
    this.complete = false;
    for (let level = finest; level <= coarsest; level++) at(this.levelBoxes, level).union(node.geometry);
  }

  private interval(node: Branch, view: BoundsView): void {
    const distance = node.sphere.center.distanceTo(view.eye);
    const roundoff = view.eye.length() * ROUND;
    const near = view.ortho ? 1 : Math.max(distance - node.sphere.radius - roundoff, 1e-6);
    const far = view.ortho ? 1 : Math.max(distance + node.sphere.radius + roundoff, 1e-6);
    this.low = ((2 * node.smallest * view.scale) / far) * (1 - ROUND * 4);
    this.high = ((2 * node.largest * view.scale) / near) * (1 + ROUND * 4);
    // Float32 overflow/underflow can invalidate a real-number interval. Keep all
    // levels in these unusual cases instead of making an unsupported proof.
    if (
      !Number.isFinite(this.high) ||
      this.high > 1e30 ||
      this.low < 1e-30 ||
      node.unsafe ||
      unsafe(view.scale) ||
      distance > 1e15 ||
      view.eye.length() > 1e15
    ) {
      this.low = 0;
      this.high = Infinity;
    }
  }
}

/** Upper bound on the largest singular value, exact for orthogonal matrix axes. */
export function stretch(matrix: Matrix4): number {
  const e = matrix.elements;
  const xy = Math.abs(e[0] * e[4] + e[1] * e[5] + e[2] * e[6]);
  const xz = Math.abs(e[0] * e[8] + e[1] * e[9] + e[2] * e[10]);
  const yz = Math.abs(e[4] * e[8] + e[5] * e[9] + e[6] * e[10]);
  return Math.sqrt(
    Math.max(e[0] ** 2 + e[1] ** 2 + e[2] ** 2 + xy + xz, e[4] ** 2 + e[5] ** 2 + e[6] ** 2 + xy + yz, e[8] ** 2 + e[9] ** 2 + e[10] ** 2 + xz + yz),
  );
}

function fitting(levels: readonly { maxPixels: number }[], height: number): number {
  for (let i = levels.length - 1; i > 0; i--) if (height <= at(levels, i).maxPixels) return i;
  return 0;
}

function expand(box: Box3, center: Vector3, radius: number): void {
  box.expandByPoint(extent.copy(center).addScalar(-radius));
  box.expandByPoint(extent.copy(center).addScalar(radius));
}

function at<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`InstancedLod bounds: index ${index} out of range`);
  return value;
}

// These broad limits stay well inside float32's squared-length and product range.
// Outside them, retain all levels and let the GPU make the original selection.
function unsafe(value: number): boolean {
  return !Number.isFinite(value) || Math.abs(value) > 1e15 || (value !== 0 && Math.abs(value) < 1e-15);
}

function enclosing(box: Box3, sphere: Sphere): void {
  box.getBoundingSphere(sphere);
  if (!Number.isFinite(sphere.radius) || !Number.isFinite(sphere.center.lengthSq())) {
    sphere.center.set(0, 0, 0);
    sphere.radius = Infinity;
  }
}

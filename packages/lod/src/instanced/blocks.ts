import { Box3, Matrix4, Sphere, Vector3 } from "three/webgpu";
import { FADE, lastFitting } from "../levels.js";
import { at } from "../at.js";
import { stretch } from "../three.js";
import { Dirty } from "./dirty.js";

// Cover float32 matrix products, distances and threshold arithmetic: near a switch,
// uncertain blocks keep both levels.
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
  unsafe: boolean;
}

/** An orthographic view's level boxes, which depend on its scale but not on where it looks from. */
interface Kept {
  scale: number;
  forced: number | null;
  maxPixels: number[];
  boxes: Box3[];
}
/** Orthographic scales kept per crowd: a shadow map's cascades. */
const KEPT = 8;

/** A view as a crowd's blocks see it, in the crowd's space. */
export interface BlockView {
  eye: Vector3;
  /** pixels per unit of subtense (perspective) or of size (orthographic), × Lod.quality */
  scale: number;
  ortho: boolean;
  fades: boolean;
  forced: number | null;
}

/** Cached spatial blocks: instance edits refit leaves; moving views visit only blocks. */
export class Blocks {
  private readonly block: number;
  private readonly leaves: number;
  private readonly tree: Branch[];
  private readonly dirty: Dirty;
  private readonly radii: Float64Array;
  private readonly roundoff: Float64Array;
  private readonly unsafe: Uint8Array;
  private readonly levelBoxes: Box3[] = [];
  /** Level boxes of recent orthographic views, until the instances change. */
  private readonly kept: Kept[] = [];
  private low = 0;
  private high = 0;
  private padding = 0;

  constructor(
    private readonly matrices: Float32Array,
    private readonly spheres: Float32Array,
    private readonly source: Sphere,
    /** Set to enclose every instance on refit. */
    private readonly bounds: Sphere,
    draws: number,
    /** Radius enclosing every placed level about source.center. */
    private readonly rest: { readonly radius: number },
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
      this.radii[i] = this.rest.radius * stretch(matrix);
      const e = matrix.elements;
      // Absolute terms also cover cancellation in the shader's transformed center.
      const terms = Math.max(
        Math.abs(e[0] * center.x) + Math.abs(e[4] * center.y) + Math.abs(e[8] * center.z) + Math.abs(e[12]),
        Math.abs(e[1] * center.x) + Math.abs(e[5] * center.y) + Math.abs(e[9] * center.z) + Math.abs(e[13]),
        Math.abs(e[2] * center.x) + Math.abs(e[6] * center.y) + Math.abs(e[10] * center.z) + Math.abs(e[14]),
        radius,
        this.rest.radius,
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
    this.kept.length = 0;
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
    enclosing(at(this.tree, 1).geometry, this.bounds);
  }

  private leaf(node: Branch, block: number): void {
    node.geometry.makeEmpty();
    node.centers.makeEmpty();
    node.smallest = Infinity;
    node.largest = node.reach = 0;
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
  }

  /**
   * Each level's bounds: where its instances may draw for `view`, every level's the whole crowd's until `view` is
   * `measured`. Returns the levels some instance draws, whichever way `view` faces, coarsest first.
   */
  select(levels: readonly { maxPixels: number }[], view: BlockView, reaches: Sphere[], measured: boolean, root: Matrix4): number[] {
    while (this.levelBoxes.length < levels.length) this.levelBoxes.push(new Box3());
    for (const box of this.levelBoxes) box.makeEmpty();
    if (!this.bounds.isEmpty()) {
      if (view.ortho && this.nearby(view)) this.keep(levels, view);
      else this.visit(1, levels, view);
    }
    const drawn: number[] = [];
    for (let level = levels.length - 1; level >= 0; level--) if (!at(this.levelBoxes, level).isEmpty()) drawn.push(level);
    if (!measured && !this.bounds.isEmpty()) for (const box of this.levelBoxes) box.copy(at(this.tree, 1).geometry);
    this.enclose(levels, view, reaches, root, measured);
    return drawn;
  }

  /** Whether every node is near enough to `view` that only its scale decides an orthographic interval (see `interval`). */
  private nearby(view: BlockView): boolean {
    const { sphere } = at(this.tree, 1);
    return view.eye.length() <= 1e15 && sphere.center.distanceTo(view.eye) + sphere.radius <= 1e15;
  }

  /** Visit for an orthographic view only at a scale not seen since the instances changed: each cascade of a moving shadow map keeps its scale. */
  private keep(levels: readonly { maxPixels: number }[], view: BlockView): void {
    let kept = this.kept.find(
      (kept) =>
        kept.scale === view.scale &&
        kept.forced === view.forced &&
        kept.maxPixels.length === levels.length &&
        kept.maxPixels.every((value, level) => value === at(levels, level).maxPixels),
    );
    if (!kept) {
      this.visit(1, levels, view);
      kept = { scale: view.scale, forced: view.forced, maxPixels: levels.map((level) => level.maxPixels), boxes: this.levelBoxes.map((box) => box.clone()) };
      if (this.kept.unshift(kept) > KEPT) this.kept.pop();
      return;
    }
    kept.boxes.forEach((box, level) => at(this.levelBoxes, level).copy(box));
  }

  private enclose(levels: readonly { maxPixels: number }[], view: BlockView, reaches: Sphere[], root: Matrix4, measured: boolean): void {
    const top = at(this.tree, 1);
    const axis = root.getMaxScaleOnAxis();
    // Three transforms a culling sphere by max-axis scale, which underbounds shear.
    const dilation = axis > 0 ? stretch(root) / axis : 1;
    reaches.forEach((sphere, level) => {
      enclosing(at(this.levelBoxes, level), sphere);
      const next = levels[level + 1];
      if (measured && !top.unsafe && !unsafe(view.scale) && view.eye.length() < 1e15 && !sphere.isEmpty() && !view.ortho && view.forced === null && next) {
        const threshold = next.maxPixels * (view.fades ? 1 - FADE : 1);
        const radius = (2 * top.largest * view.scale * (1 + ROUND * 4)) / threshold + top.reach + view.eye.length() * ROUND;
        if (radius < sphere.radius) sphere.set(view.eye, radius);
      }
      if (!sphere.isEmpty()) sphere.radius *= dilation;
    });
  }

  private visit(index: number, levels: readonly { maxPixels: number }[], view: BlockView): void {
    const node = at(this.tree, index);
    if (node.geometry.isEmpty()) return;
    const [finest, coarsest] = this.span(node, levels, view);
    if (finest !== coarsest && index < this.leaves) {
      this.visit(index * 2, levels, view);
      this.visit(index * 2 + 1, levels, view);
      return;
    }
    for (let level = finest; level <= coarsest; level++) at(this.levelBoxes, level).union(node.geometry);
  }

  /** The finest and coarsest levels `node` may draw, fade partner included. Must match the GPU's selection and `levelOf`. */
  private span(node: Branch, levels: readonly { maxPixels: number }[], view: BlockView): [finest: number, coarsest: number] {
    this.interval(node, view);
    const { high } = this;
    // Infinity marks an unsafe float32 interval; even legal infinite thresholds
    // cannot exclude the source when the GPU's height may be NaN.
    let finest = view.forced ?? (high === Infinity ? 0 : lastFitting(levels, high));
    const coarsest = view.forced ?? lastFitting(levels, this.low);
    if (view.fades && finest > 0 && high >= at(levels, finest).maxPixels * (1 - FADE) * (1 - ROUND)) finest--;
    return [finest, coarsest];
  }

  private interval(node: Branch, view: BlockView): void {
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

function expand(box: Box3, center: Vector3, radius: number): void {
  box.expandByPoint(extent.copy(center).addScalar(-radius));
  box.expandByPoint(extent.copy(center).addScalar(radius));
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

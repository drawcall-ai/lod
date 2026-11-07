import {
  type Camera,
  type Frustum,
  Matrix4,
  StorageBufferAttribute,
  StorageInstancedBufferAttribute,
  Vector3,
  Vector4,
  type Renderer,
  type Sphere,
} from "three/webgpu";
import { at } from "../at.js";
import { ARGS_BYTES, args, type ArgsSlice } from "./args.js";
import { upload } from "./dirty.js";
import { Kernel, type IndirectDraw, type Pass, type RangeAim, type Target } from "./kernel.js";
import type { Places, Seed } from "./places.js";
import type { BlockView } from "./blocks.js";
import type { View } from "../view.js";

const CURRENT: readonly Pass[] = [];

/** What a view selects with: see `Selection.aim`. */
export interface Aim extends BlockView {
  /** the view's frustum in the crowd's space */
  frustum: Frustum;
}

const inverse = new Matrix4();

/** `camera`'s `view` as the instances of a crowd placed by `matrixWorld` see it, written into `out`. */
export function sight(out: Aim, view: View, camera: Camera, matrixWorld: Matrix4, quality: number, forced: number | null): Aim {
  inverse.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(matrixWorld);
  out.frustum.setFromProjectionMatrix(inverse, camera.coordinateSystem, camera.reversedDepth);
  out.eye.copy(view.eye).applyMatrix4(inverse.copy(matrixWorld).invert());
  out.scale = view.scale * quality * (view.ortho ? matrixWorld.getMaxScaleOnAxis() : 1);
  out.ortho = view.ortho;
  out.fades = view.fades;
  out.forced = forced;
  return out;
}

/** One view's selection: per level, the instances it draws and their fades, from `first`, and its indirect draws. */
export interface Slots {
  /** the index of the instance each slot draws */
  readonly indices: StorageBufferAttribute;
  /** its signed fade */
  readonly fades: StorageBufferAttribute;
  /** this view's draws, `ARGS_BYTES` apart */
  args: ArgsSlice;
}

/** A view's slots and the aim they were last selected with. */
interface Selected extends Slots, Target {
  aimed: boolean;
  readonly planes: Vector4[];
  readonly maxPixels: number[];
  /** Bumped whenever the slots stop matching the aim or the instances. */
  revision: number;
  /** The revision the renderer's buffers hold. */
  taken: number;
}

/** The slots of each view of an InstancedLod's instances, and when its kernel has to fill them again (see kernel.ts). */
export class Selection {
  /** The instances' colours (RGB, padded to four floats), once there are any. */
  colors: StorageInstancedBufferAttribute | null = null;
  readonly progress: Kernel["progress"];
  /** The radius around an instance's centre, in its own space, that every level and its sway stay within. */
  readonly reach: Kernel["reach"];
  private readonly kernel: Kernel;
  private readonly views = new Map<Camera, Selected>();
  private buffers: Buffers;
  /** Survivors' scaled matrices, while survivors scale. */
  private scaled: StorageInstancedBufferAttribute | null = null;
  private readonly ranged: RangeAim = { eye: new Vector3(), radius: 0, ramp: 0, survivors: false };
  private hasRange = false;
  /** Whether a selection was taken from these buffers, and one with colours. */
  private started = false;
  private coloured = false;

  constructor(
    private readonly places: Places,
    /** One instance's bounding sphere, in its own space. */
    sphere: Sphere,
    /** Per level, whether it draws anything. */
    private readonly drawing: readonly boolean[],
    private draws: readonly IndirectDraw[],
    fallback: readonly number[],
  ) {
    const seed = places.seed();
    this.buffers = buffers(places.capacity, seed, drawing);
    if (seed.colors) this.useColors(seed.colors);
    this.kernel = new Kernel(sphere, this.buffers.first, fallback, places.occupied);
    this.progress = this.kernel.progress;
    this.reach = this.kernel.reach;
    this.bind();
    this.kernel.writeDraws(draws);
  }

  /** The instances' matrices, as the CPU writes them. */
  get matrices(): StorageInstancedBufferAttribute {
    return this.buffers.matrices;
  }

  /** The instances' keep ratios. */
  get keeps(): StorageBufferAttribute {
    return this.buffers.keeps;
  }

  /** Places for instances in every buffer: the store's capacity. */
  get capacity(): number {
    return this.buffers.capacity;
  }

  /** The matrices level draws read: the scaled ones while survivors scale. */
  get drawn(): StorageInstancedBufferAttribute {
    return this.scaled ?? this.matrices;
  }

  /** Select from the places again, whose capacity changed: every buffer sized by it is replaced. */
  resize(): void {
    const { places } = this;
    const old = [this.matrices, this.keeps, this.colors, this.scaled];
    const survivors = this.scaled !== null;
    this.colors = null;
    const seed = places.seed();
    this.buffers = buffers(places.capacity, seed, this.drawing);
    if (seed.colors) this.useColors(seed.colors);
    this.scaled = survivors ? scaledMatrices(this.capacity) : null;
    this.bind();
    for (const view of this.views.values()) {
      for (const attribute of [view.indices, view.fades, view.shown]) attribute.dispose();
      view.args.dispose();
      Object.assign(view, this.slots());
    }
    this.started = this.coloured = false;
    this.changed();
    for (const attribute of old) attribute?.dispose();
  }

  /** Select with `range`, in the crowd's space, in every view from now on, or with none. */
  range(range: RangeAim | null): void {
    const { ranged } = this;
    const same = range
      ? this.hasRange && ranged.eye.equals(range.eye) && ranged.radius === range.radius && ranged.ramp === range.ramp && ranged.survivors === range.survivors
      : !this.hasRange;
    if (same) return;
    this.hasRange = range !== null;
    if (range) {
      ranged.eye.copy(range.eye);
      Object.assign(ranged, { radius: range.radius, ramp: range.ramp, survivors: range.survivors });
    }
    const survivors = range?.survivors ?? false;
    if (survivors !== (this.scaled !== null)) {
      this.scaled?.dispose();
      this.scaled = survivors ? scaledMatrices(this.capacity) : null;
      this.bind();
    }
    this.kernel.range(range);
    this.changed();
  }

  private bind(): void {
    this.kernel.bind(this.matrices, this.keeps, this.scaled ?? unscaled, this.buffers.first);
  }

  /** A view's slots and draws for the current capacity. */
  private slots(): Pick<Selected, "indices" | "fades" | "shown" | "args"> {
    return {
      indices: new StorageBufferAttribute(new Uint32Array(this.buffers.slotCount), 1),
      fades: new StorageBufferAttribute(new Float32Array(this.buffers.slotCount), 1),
      shown: new StorageBufferAttribute(new Uint32Array(Math.max(this.capacity, 1)), 1),
      args: this.allocate(this.draws),
    };
  }

  private allocate(draws: readonly IndirectDraw[]): ArgsSlice {
    const values = new Uint32Array((draws.length * ARGS_BYTES) / 4);
    draws.forEach((draw, k) => {
      const base = (k * ARGS_BYTES) / 4;
      const first = at(this.buffers.first, draw.level);
      if (first === null) throw new Error("InstancedLod: a draw of a level that draws nothing");
      // indexed: count, instances, first index, base vertex, first instance;
      // else: count, instances, first vertex, first instance.
      values[base] = draw.count;
      values[base + 2] = draw.start;
      values[base + (draw.indexed ? 4 : 3)] = first;
    });
    return args.take(values);
  }

  /** `camera`'s slots, made when first asked for: until it is aimed, its draws draw nothing. */
  view(camera: Camera): Selected {
    let view = this.views.get(camera);
    if (view) return view;
    view = {
      ...this.slots(),
      aimed: false,
      eye: new Vector3(),
      scale: 0,
      ortho: false,
      fading: false,
      forced: -1,
      planes: Array.from({ length: 6 }, () => new Vector4()),
      maxPixels: this.drawing.map(() => 0),
      revision: 0,
      taken: -1,
    };
    this.views.set(camera, view);
    return view;
  }

  /** Free the slots of the views of cameras that `viewing` no longer counts. */
  forget(viewing: (camera: Camera) => boolean): void {
    for (const [camera, view] of this.views) {
      if (viewing(camera)) continue;
      this.views.delete(camera);
      view.indices.dispose();
      view.fades.dispose();
      view.shown.dispose();
      view.args.dispose();
    }
  }

  /** Slots and kernels survive arrivals; only the variable-size draw tables are replaced. */
  append(draws: readonly IndirectDraw[]): number {
    const offset = this.draws.length * ARGS_BYTES;
    this.draws = [...this.draws, ...draws];
    for (const view of this.views.values()) {
      const previous = view.args;
      view.args = this.allocate(this.draws);
      previous.dispose();
    }
    this.kernel.writeDraws(this.draws);
    this.changed();
    return offset;
  }

  /** Residency is data, including the previous route for the arrival's dither fade. */
  route(fallback: readonly number[], fade = false): void {
    this.kernel.route(fallback, fade);
    this.changed();
  }

  /** Select for `camera` as `aim` says next time it draws; nothing runs while the aim stays the same. */
  aim(camera: Camera, aim: Aim, levels: readonly { maxPixels: number }[]): void {
    const view = this.view(camera);
    const forced = aim.forced ?? -1;
    // any finite stand-in for level 0's Infinity
    const maxPixels = levels.map((level) => Math.min(level.maxPixels, 3.4e38));
    const { planes } = aim.frustum;
    const same =
      view.aimed &&
      view.eye.equals(aim.eye) &&
      view.scale === aim.scale &&
      view.ortho === aim.ortho &&
      view.fading === aim.fades &&
      view.forced === forced &&
      maxPixels.every((value, l) => view.maxPixels[l] === value) &&
      view.planes.every(
        (plane, i) => plane.x === planes[i]?.normal.x && plane.y === planes[i].normal.y && plane.z === planes[i].normal.z && plane.w === planes[i].constant,
      );
    if (same) return;
    view.aimed = true;
    view.eye.copy(aim.eye);
    view.scale = aim.scale;
    view.ortho = aim.ortho;
    view.fading = aim.fades;
    view.forced = forced;
    maxPixels.forEach((value, l) => (view.maxPixels[l] = value));
    view.planes.forEach((plane, i) => {
      const { normal, constant } = at(planes, i);
      plane.set(normal.x, normal.y, normal.z, constant);
    });
    view.revision++;
  }

  /** The instances, their range, routes or handover changed since the last selection of every view. */
  changed(): void {
    for (const view of this.views.values()) view.revision++;
  }

  /** Bring the instances up to date on `renderer` before any view takes its passes. */
  prepare(renderer: Renderer): void {
    this.places.prepare(renderer);
  }

  /** Every view's record of the level each place drew, which the places clear for a new instance. */
  shown(): StorageBufferAttribute[] {
    return [...this.views.values()].map((view) => view.shown);
  }

  /** Clear every view's record of the levels the places from `start` to `end` drew: they hold new instances. */
  forgetShown(start: number, end: number): void {
    // Only the GPU writes a view's record: its CPU array stays zeros.
    for (const view of this.views.values()) upload(view.shown, start, Math.min(end, view.shown.count));
  }

  /** The passes the renderer has to run for `camera`'s slots to be current in its buffers, or none. */
  take(camera: Camera): readonly Pass[] {
    const view = this.views.get(camera);
    if (!view?.aimed || view.taken === view.revision) return CURRENT;
    // Creating a buffer leaves its update ranges in place: its first upload takes all of it.
    if (!this.started) {
      this.started = true;
      this.matrices.clearUpdateRanges();
    }
    if (this.colors && !this.coloured) {
      this.coloured = true;
      this.colors.clearUpdateRanges();
    }
    view.taken = view.revision;
    return this.kernel.load(view, this.places.end);
  }

  /** Carry `colors` (4 floats per instance) with the instances from now on. */
  useColors(colors: Float32Array): void {
    if (this.colors) return;
    this.colors = new StorageInstancedBufferAttribute(colors, 4);
    this.changed();
  }

  /** Frees its buffers and passes. */
  dispose(): void {
    for (const attribute of [this.matrices, this.keeps, this.colors, this.scaled]) attribute?.dispose();
    this.forget(() => false);
    this.kernel.dispose();
  }
}

/** What a selection holds per place for instances, and where each level's slots start. */
interface Buffers {
  capacity: number;
  matrices: StorageInstancedBufferAttribute;
  keeps: StorageBufferAttribute;
  /** Per level, its first slot, or null for a level that draws nothing. */
  first: Array<number | null>;
  slotCount: number;
}

/** Buffers for `capacity` places starting from `seed`, with slots for every level that is `drawing`. */
function buffers(capacity: number, seed: Seed, drawing: readonly boolean[]): Buffers {
  let next = 0;
  const first = drawing.map((draws) => (draws ? next++ * capacity : null));
  return {
    capacity,
    matrices: new StorageInstancedBufferAttribute(padded(seed.matrices, 16), 16),
    keeps: new StorageBufferAttribute(padded(seed.keeps, 1), 1),
    first,
    slotCount: Math.max(next * capacity, 1),
  };
}

/** A binding for the scaled matrices while survivors do not scale: nothing writes or reads it. */
const unscaled = new StorageInstancedBufferAttribute(new Float32Array(16), 16);

const scaledMatrices = (capacity: number) => new StorageInstancedBufferAttribute(new Float32Array(Math.max(capacity, 1) * 16), 16);

/** `array`, or one empty item for an empty one: a storage buffer is never empty. */
const padded = (array: Float32Array, size: number): Float32Array => (array.length > 0 ? array : new Float32Array(size));

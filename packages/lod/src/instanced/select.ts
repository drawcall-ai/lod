import {
  type Camera,
  type Frustum,
  Matrix4,
  StorageBufferAttribute,
  StorageInstancedBufferAttribute,
  Vector3,
  Vector4,
  type ComputeNode,
  type Renderer,
  type Sphere,
} from "three/webgpu";
import { at } from "../at.js";
import { ARGS_BYTES, args, type ArgsSlice } from "./args.js";
import { Kernel, type IndirectDraw, type Target } from "./kernel.js";
import type { BlockView } from "./blocks.js";
import type { View } from "../view.js";

const CURRENT: ComputeNode[] = [];

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
  /** Per renderer, the revision its buffers hold. */
  readonly current: WeakMap<Renderer, number>;
}

/** The slots of each view of an InstancedLod's instances, and when its kernel has to fill them again (see kernel.ts). */
export class Selection {
  /** The instances' matrices, as `setMatrixAt` writes them; level draws read them through their slots. */
  readonly matrices: StorageInstancedBufferAttribute;
  /** The instances' colours (RGB, padded to four floats), once there are any. */
  colors: StorageInstancedBufferAttribute | null = null;
  readonly count: number;
  /** Per level, its first slot, or null for a level that draws nothing. */
  readonly first: Array<number | null>;
  readonly progress: Kernel["progress"];
  /** The radius around an instance's centre, in its own space, that every level and its sway stay within. */
  readonly reach: Kernel["reach"];
  private readonly kernel: Kernel;
  private readonly views = new Map<Camera, Selected>();
  private readonly slotCount: number;
  /** Renderers that have taken a selection: each keeps its own copy of the buffers. */
  private readonly renderers = new WeakSet<Renderer>();
  private readonly colorRenderers = new WeakSet<Renderer>();
  private rendererCount = 0;

  constructor(
    /** 16 floats per instance */
    matrices: Float32Array,
    /** One instance's bounding sphere, in its own space. */
    sphere: Sphere,
    /** Per level, whether it draws anything. */
    drawing: readonly boolean[],
    private draws: readonly IndirectDraw[],
    fallback: readonly number[],
  ) {
    const count = matrices.length / 16;
    this.count = count;
    this.matrices = new StorageInstancedBufferAttribute(matrices, 16);
    let next = 0;
    this.first = drawing.map((draws) => (draws ? next++ * count : null));
    this.slotCount = Math.max(next * count, 1);
    this.kernel = new Kernel(this.matrices, count, sphere, this.first, fallback);
    this.progress = this.kernel.progress;
    this.reach = this.kernel.reach;
    this.kernel.writeDraws(draws);
  }

  private allocate(draws: readonly IndirectDraw[]): ArgsSlice {
    const values = new Uint32Array((draws.length * ARGS_BYTES) / 4);
    draws.forEach((draw, k) => {
      const base = (k * ARGS_BYTES) / 4;
      const first = at(this.first, draw.level);
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
      indices: new StorageBufferAttribute(new Uint32Array(this.slotCount), 1),
      fades: new StorageBufferAttribute(new Float32Array(this.slotCount), 1),
      shown: new StorageBufferAttribute(new Uint32Array(Math.max(this.count, 1)), 1),
      args: this.allocate(this.draws),
      aimed: false,
      eye: new Vector3(),
      scale: 0,
      ortho: false,
      fading: false,
      forced: -1,
      planes: Array.from({ length: 6 }, () => new Vector4()),
      maxPixels: this.first.map(() => 0),
      revision: 0,
      current: new WeakMap(),
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

  /** The instances, their routes or their handover changed since the last selection of every view. */
  changed(): void {
    for (const view of this.views.values()) view.revision++;
  }

  /** The passes `renderer` has to run for `camera`'s slots to be current in its buffers, or none. */
  take(renderer: Renderer, camera: Camera): ComputeNode[] {
    const view = this.views.get(camera);
    if (!view?.aimed || view.current.get(renderer) === view.revision) return CURRENT;
    const first = !this.renderers.has(renderer);
    if (first) {
      this.renderers.add(renderer);
      this.rendererCount = Math.min(2, this.rendererCount + 1);
    }
    // Three clears updateRanges globally after one backend uploads them. A second,
    // lagging renderer needs the whole current source, including earlier edits.
    // Initial buffer creation also leaves ranges uncleared; start it with none.
    if (first || this.rendererCount > 1) {
      this.matrices.clearUpdateRanges();
    }
    if (this.colors && (!this.colorRenderers.has(renderer) || this.rendererCount > 1)) {
      this.colorRenderers.add(renderer);
      this.colors.clearUpdateRanges();
    }
    view.current.set(renderer, view.revision);
    return this.kernel.load(view);
  }

  /** Carry `colors` (4 floats per instance) with the instances from now on. */
  useColors(colors: Float32Array): void {
    if (this.colors) return;
    this.colors = new StorageInstancedBufferAttribute(colors, 4);
    this.changed();
  }

  /** Frees its buffers and passes. */
  dispose(): void {
    for (const attribute of [this.matrices, this.colors]) attribute?.dispose();
    this.forget(() => false);
    this.kernel.dispose();
  }
}

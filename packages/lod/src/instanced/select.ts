import {
  type IndirectStorageBufferAttribute,
  StorageBufferAttribute,
  StorageInstancedBufferAttribute,
  Vector3,
  type ComputeNode,
  type Node,
  type Renderer,
  type Sphere,
} from "three/webgpu";
import {
  Fn,
  If,
  Return,
  atomicAdd,
  atomicLoad,
  atomicStore,
  distance,
  float,
  instanceIndex,
  int,
  max,
  smoothstep,
  storage,
  uint,
  uniform,
  vec4,
} from "three/tsl";
import { FADE } from "../levels.js";
import { maxScale } from "../tsl.js";
import { ARGS_BYTES, args, type ArgsSlice } from "./args.js";

export { ARGS_BYTES } from "./args.js";

const CURRENT: ComputeNode[] = [];

// Sorting the instances of an InstancedLod into its levels, on the GPU, once per view.
//
// One thread per instance measures its height on screen from its matrix, the same way a
// Lod does on the CPU (see View: 2 r q / d, q pixels per unit of subtense times
// Lod.quality), picks its level and, near a switch, the finer level fading out with it
// (see fade.ts), and appends itself to each level it draws: its matrix, colour and signed
// fade go to that level's next free slot. Every level has `count` slots of one buffer,
// from its `first`; its draws start there (their first instance), so all levels share
// one pass, within WebGPU's default limit of 8 storage buffers per stage. A second pass hands each level's
// count to the indirect draws of its meshes and clears the counts for the next view.
// Instances at scale 0 draw in no level.

/** The slots every level draws from, `count` per level that draws, from its `first`. */
export interface Slots {
  readonly matrices: StorageInstancedBufferAttribute;
  readonly fades: StorageBufferAttribute;
  /** RGB and a pad per slot, once the instances have colours */
  colors: StorageInstancedBufferAttribute | null;
}

/** One indirect draw: a level's mesh, drawing `count` indices (or vertices) from `start`. */
export interface IndirectDraw {
  level: number;
  count: number;
  start: number;
  indexed: boolean;
}

export class Selection {
  /** The instances' matrices, as `setMatrixAt` writes them. */
  readonly matrices: StorageBufferAttribute;
  /** The instances' colours (RGB, padded to four floats), once there are any. */
  colors: StorageBufferAttribute | null = null;
  readonly count: number;
  readonly slots: Slots;
  /** Per level, its first slot, or null for a level that draws nothing. */
  readonly first: Array<number | null>;
  /** Shared page containing this selection's draws, `ARGS_BYTES` apart. */
  readonly args: IndirectStorageBufferAttribute;
  /** Byte offset of this selection's first draw in its page. */
  readonly argsOffset: number;

  // What the view sets before each selection (see InstancedLod.update).
  readonly eye = uniform(new Vector3());
  /** Pixels per unit of subtense (perspective) or of size (orthographic), × Lod.quality. */
  readonly scale = uniform(0);
  readonly ortho = uniform(0, "uint");
  readonly fades = uniform(0, "uint");
  /** The level every instance draws, or -1. */
  readonly forced = uniform(-1, "int");
  /** Per level, its maxPixels (any finite stand-in for level 0's Infinity). */
  readonly maxPixels: Array<{ value: number } & Node<"float">>;

  private readonly counts: StorageBufferAttribute;
  private readonly slice: ArgsSlice;
  // Allocation location must not specialize the handover shader for every crowd.
  private readonly argsStart = uniform(0, "uint");
  private kernels: ComputeNode[] | null = null;
  /**
   * The renderers whose buffers hold the selection for the view and instances as they are
   * (each renderer keeps its own copy of the buffers): see `aim` and `changed`.
   */
  private readonly current = new WeakMap<Renderer, number>();
  private revision = 0;
  private stable: object | undefined;
  private readonly colorRenderers = new WeakSet<Renderer>();
  private rendererCount = 0;

  constructor(
    /** 16 floats per instance */
    matrices: Float32Array,
    /** One instance's bounding sphere, in its own space. */
    private readonly sphere: Sphere,
    /** Per level, whether it draws anything. */
    drawing: readonly boolean[],
    private readonly draws: readonly IndirectDraw[],
  ) {
    const count = matrices.length / 16;
    this.count = count;
    this.matrices = new StorageBufferAttribute(matrices, 16);
    let next = 0;
    this.first = drawing.map((draws) => (draws ? next++ * count : null));
    const slots = Math.max(next * count, 1);
    this.slots = { matrices: new StorageInstancedBufferAttribute(slots, 16), fades: new StorageBufferAttribute(slots, 1), colors: null };
    this.maxPixels = drawing.map(() => uniform(0));
    this.counts = new StorageBufferAttribute(new Uint32Array(drawing.length), 1);
    const values = new Uint32Array((draws.length * ARGS_BYTES) / 4);
    draws.forEach((draw, k) => {
      const at = (k * ARGS_BYTES) / 4;
      const first = this.first[draw.level];
      if (first === null || first === undefined) throw new Error("InstancedLod: a draw of a level that draws nothing");
      // indexed: count, instances, first index, base vertex, first instance;
      // else: count, instances, first vertex, first instance.
      values[at] = draw.count;
      values[at + 2] = draw.start;
      values[at + (draw.indexed ? 4 : 3)] = first;
    });
    this.slice = args.take(values);
    this.args = this.slice.attribute;
    this.argsOffset = this.slice.offset;
    this.argsStart.value = this.argsOffset / 4;
  }

  /** Select for this view next; the uniforms are set and compared here. */
  aim(eye: Vector3, scale: number, ortho: boolean, fades: boolean, forced: number | null, levels: readonly { maxPixels: number }[], stable?: object): void {
    const same =
      this.eye.value.equals(eye) &&
      this.scale.value === scale &&
      this.ortho.value === Number(ortho) &&
      this.fades.value === Number(fades) &&
      this.forced.value === (forced ?? -1) &&
      levels.every((level, l) => this.maxPixels[l]?.value === Math.min(level.maxPixels, 3.4e38));
    // The caller can prove that changed views still produce the same solid slots.
    const reuse = stable !== undefined && stable === this.stable;
    this.stable = stable;
    if (same) return;
    if (!reuse) this.revision++;
    this.eye.value.copy(eye);
    this.scale.value = scale;
    this.ortho.value = Number(ortho);
    this.fades.value = Number(fades);
    this.forced.value = forced ?? -1;
    // any finite stand-in for level 0's Infinity
    levels.forEach((level, l) => {
      const uniform = this.maxPixels[l];
      if (uniform) uniform.value = Math.min(level.maxPixels, 3.4e38);
    });
  }

  /** The instances changed since the last selection. */
  changed(): void {
    this.revision++;
    this.stable = undefined;
  }

  /** The passes `renderer` has to run for the selection to be current in its buffers, or none. */
  take(renderer: Renderer): ComputeNode[] {
    if (this.current.get(renderer) === this.revision) return CURRENT;
    const first = !this.current.has(renderer);
    if (first) {
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
    this.current.set(renderer, this.revision);
    return this.passes();
  }

  /** Carry `colors` (4 floats per instance) with the instances from now on, into the slots. */
  useColors(colors: Float32Array): void {
    if (this.colors) return;
    this.colors = new StorageBufferAttribute(colors, 4);
    this.slots.colors = new StorageInstancedBufferAttribute(this.slots.matrices.count, 4);
    for (const kernel of this.kernels ?? []) kernel.dispose();
    this.kernels = null;
    this.changed();
  }

  /** Frees its buffers and passes. */
  dispose(): void {
    const { slots } = this;
    for (const attribute of [this.matrices, this.colors, this.counts, slots.matrices, slots.fades, slots.colors]) attribute?.dispose();
    for (const kernel of this.kernels ?? []) kernel.dispose();
    this.kernels = null;
    this.slice.dispose();
  }

  private passes(): ComputeNode[] {
    this.kernels ??= [this.selectPass(), this.handOverPass()];
    return this.kernels;
  }

  /** The pass that fills the slots. */
  private selectPass(): ComputeNode {
    const { count, sphere, colors, slots } = this;
    const matrices = storage(this.matrices, "mat4", count).setName("lodSourceMatrices");
    const sources = colors ? storage(colors, "vec4", count).setName("lodSourceColors") : null;
    const counts = storage(this.counts, "uint", this.first.length).setName("lodCounts").toAtomic();
    const out = {
      matrices: storage(slots.matrices, "mat4", slots.matrices.count).setName("lodSlotMatrices"),
      fades: storage(slots.fades, "float", slots.fades.count).setName("lodSlotFades"),
      colors: slots.colors && storage(slots.colors, "vec4", slots.colors.count).setName("lodSlotColors"),
    };
    return Fn(() => {
      const m = matrices.element(instanceIndex).toVar();
      const r = float(sphere.radius).mul(maxScale(m)).toVar();
      If(r.equal(0), () => Return());
      const centre = m.mul(vec4(sphere.center.x, sphere.center.y, sphere.center.z, 1)).xyz;
      const size = r.mul(2).mul(this.scale);
      const height = this.ortho
        .equal(uint(1))
        .select(size, size.div(max(distance(centre, this.eye), 1e-6)))
        .toVar();
      // The levels' maxPixels fall from level to level: the last one it fits is its level.
      const chosen = int(0).toVar();
      const top = float(0).toVar();
      this.maxPixels.forEach((maxPixels, l) => {
        if (l === 0) return;
        If(height.lessThanEqual(maxPixels), () => {
          chosen.assign(l);
          top.assign(maxPixels);
        });
      });
      If(this.forced.greaterThanEqual(0), () => void chosen.assign(this.forced));
      const t = float(0).toVar();
      If(this.fades.equal(uint(1)).and(chosen.greaterThan(0)), () => void t.assign(smoothstep(top.mul(1 - FADE), top, height)));
      const emit = (level: number, first: number, fade: Node<"float">) => {
        const slot = atomicAdd(counts.element(level), uint(1)).add(first).toVar();
        out.matrices.element(slot).assign(m);
        out.fades.element(slot).assign(fade);
        if (out.colors && sources) out.colors.element(slot).assign(sources.element(instanceIndex));
      };
      this.first.forEach((first, level) => {
        if (first === null) return;
        If(chosen.equal(level), () => emit(level, first, t));
        // The finer neighbour fading out with it.
        If(chosen.equal(level + 1).and(t.greaterThan(0)), () => emit(level, first, t.negate()));
      });
    })().compute(count);
  }

  private handOverPass(): ComputeNode {
    const counts = storage(this.counts, "uint", this.first.length).setName("lodCounts").toAtomic();
    const args = storage(this.args, "uint", this.args.count).setName("lodDrawArgs");
    return Fn(() => {
      this.draws.forEach((draw, k) => {
        const at = this.argsStart.add((k * ARGS_BYTES) / 4);
        const first = this.first[draw.level];
        if (first === null || first === undefined) throw new Error("InstancedLod: a draw of a level that draws nothing");
        // A new/reused slice may already have a GPU page. Initialize its fixed fields
        // here too; uploading the CPU page would erase other crowds' live counts.
        args.element(at).assign(uint(draw.count));
        args.element(at.add(1)).assign(atomicLoad(counts.element(draw.level)));
        args.element(at.add(2)).assign(uint(draw.start));
        args.element(at.add(3)).assign(uint(draw.indexed ? 0 : first));
        args.element(at.add(4)).assign(uint(draw.indexed ? first : 0));
      });
      this.first.forEach((_, l) => atomicStore(counts.element(l), uint(0)));
    })().compute(1);
  }
}

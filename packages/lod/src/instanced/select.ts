import {
  type IndirectStorageBufferAttribute,
  StorageBufferAttribute,
  StorageInstancedBufferAttribute,
  Vector3,
  Vector4,
  type ComputeNode,
  type Node,
  type Renderer,
  type Sphere,
} from "three/webgpu";
import {
  Fn,
  If,
  Loop,
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
interface Slots {
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
  get args(): IndirectStorageBufferAttribute {
    return this.slice.attribute;
  }
  /** Byte offset of this selection's first draw in its page. */
  get argsOffset(): number {
    return this.slice.offset;
  }

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
  private slice: ArgsSlice;
  private readonly routes: Array<{ value: number } & Node<"int">>;
  private readonly previous: Array<{ value: number } & Node<"int">>;
  // Crowd dimensions are data; equal ladders share shader modules regardless of capacity.
  private readonly starts: Array<{ value: number } & Node<"uint">>;
  private readonly bounds = uniform(new Vector4());
  readonly progress = uniform(1);
  private readonly drawCount = uniform(0, "uint");
  private readonly records = storage(new StorageBufferAttribute(new Uint32Array(4), 4), "uvec4", 0)
    .setName("lodDraws")
    .toReadOnly();
  private readonly arguments = storage(new StorageBufferAttribute(new Uint32Array(5), 1), "uint", 0).setName("lodDrawArgs");
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
    sphere: Sphere,
    /** Per level, whether it draws anything. */
    drawing: readonly boolean[],
    private draws: readonly IndirectDraw[],
    fallback: readonly number[] = drawing.map((_, i) => i),
  ) {
    const count = matrices.length / 16;
    this.count = count;
    this.matrices = new StorageBufferAttribute(matrices, 16);
    let next = 0;
    this.first = drawing.map((draws) => (draws ? next++ * count : null));
    this.starts = this.first.map((first) => uniform(first ?? 0, "uint"));
    this.bounds.value.set(sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius);
    const slots = Math.max(next * count, 1);
    this.slots = { matrices: new StorageInstancedBufferAttribute(slots, 16), fades: new StorageBufferAttribute(slots, 1), colors: null };
    this.maxPixels = drawing.map(() => uniform(0));
    this.counts = new StorageBufferAttribute(new Uint32Array(drawing.length), 1);
    this.slice = this.allocate(draws);
    this.argsStart.value = this.argsOffset / 4;
    this.routes = fallback.map((level) => uniform(level, "int"));
    this.previous = fallback.map((level) => uniform(level, "int"));
    this.writeDraws(draws);
  }

  private allocate(draws: readonly IndirectDraw[]): ArgsSlice {
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
    return args.take(values);
  }

  /** Slots and kernels survive arrivals; only the variable-size draw table is replaced. */
  append(draws: readonly IndirectDraw[]): number {
    const offset = this.draws.length * ARGS_BYTES;
    const previous = this.slice;
    this.draws = [...this.draws, ...draws];
    this.slice = this.allocate(this.draws);
    this.argsStart.value = this.argsOffset / 4;
    this.writeDraws(this.draws);
    previous.dispose();
    this.changed();
    return offset;
  }

  /** Residency is data, including the previous route for the arrival's dither fade. */
  route(fallback: readonly number[], fade = false): void {
    fallback.forEach((level, i) => {
      const route = this.routes[i];
      const previous = this.previous[i];
      if (!route || !previous) throw new Error("InstancedLod: missing fallback route");
      previous.value = fade ? route.value : level;
      route.value = level;
    });
    this.progress.value = fade ? 0 : 1;
    this.changed();
  }

  private writeDraws(draws: readonly IndirectDraw[]): void {
    const values = new Uint32Array(Math.max(draws.length, 1) * 4);
    draws.forEach((draw, i) => values.set([draw.level, draw.count, draw.start, Number(draw.indexed)], i * 4));
    const previous = this.records.value;
    this.records.value = new StorageBufferAttribute(values, 4);
    this.arguments.value = this.args;
    this.drawCount.value = draws.length;
    previous.dispose();
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
    this.records.value.dispose();
  }

  private passes(): ComputeNode[] {
    this.kernels ??= [this.selectPass(), this.handOverPass()];
    return this.kernels;
  }

  /** The pass that fills the slots. */
  private selectPass(): ComputeNode {
    const { count, colors, slots } = this;
    const matrices = storage(this.matrices, "mat4", 0).setName("lodSourceMatrices");
    const sources = colors ? storage(colors, "vec4", 0).setName("lodSourceColors") : null;
    const counts = storage(this.counts, "uint", 0).setName("lodCounts").toAtomic();
    const out = {
      matrices: storage(slots.matrices, "mat4", 0).setName("lodSlotMatrices"),
      fades: storage(slots.fades, "float", 0).setName("lodSlotFades"),
      colors: slots.colors && storage(slots.colors, "vec4", 0).setName("lodSlotColors"),
    };
    return Fn(() => {
      const m = matrices.element(instanceIndex).toVar();
      const r = this.bounds.w.mul(maxScale(m)).toVar();
      If(r.equal(0), () => Return());
      const centre = m.mul(vec4(this.bounds.xyz, 1)).xyz;
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
      const selected = chosen.toVar();
      const finer = chosen.sub(1).toVar();
      const before = chosen.toVar();
      const beforeFiner = chosen.sub(1).toVar();
      this.routes.forEach((route, level) => {
        If(chosen.equal(level), () => {
          selected.assign(route);
          finer.assign(this.routes[level - 1] ?? route);
          before.assign(this.previous[level] ?? route);
          beforeFiner.assign(this.previous[level - 1] ?? this.previous[level] ?? route);
        });
      });
      const afterFade = selected.equal(finer).select(float(0), t).toVar();
      const beforeFade = before.equal(beforeFiner).select(float(0), t).toVar();
      t.assign(afterFade);
      // Mirrors residency.handover: only two slots per instance, including at a height boundary.
      If(this.progress.lessThan(1).and(before.notEqual(selected).or(beforeFiner.notEqual(finer))), () => {
        If(this.progress.lessThan(1 / 3), () => {
          selected.assign(before);
          finer.assign(beforeFiner);
          t.assign(beforeFade.greaterThan(0).select(beforeFade.add(float(1).sub(beforeFade).mul(this.progress).mul(3)), float(0)));
        })
          .ElseIf(this.progress.lessThan(2 / 3), () => {
            selected.assign(afterFade.greaterThan(0).select(finer, selected));
            finer.assign(beforeFade.greaterThan(0).select(beforeFiner, before));
            t.assign(float(1).sub(this.progress.sub(1 / 3).mul(3)));
          })
          .Else(() => {
            t.assign(
              afterFade.greaterThan(0).select(
                float(1).sub(
                  float(1)
                    .sub(afterFade)
                    .mul(this.progress.sub(2 / 3))
                    .mul(3),
                ),
                float(0),
              ),
            );
          });
        If(selected.equal(finer), () => void t.assign(0));
      });
      const emit = (level: number, first: Node<"uint">, fade: Node<"float">) => {
        const slot = atomicAdd(counts.element(level), uint(1)).add(first).toVar();
        out.matrices.element(slot).assign(m);
        out.fades.element(slot).assign(fade);
        if (out.colors && sources) out.colors.element(slot).assign(sources.element(instanceIndex));
      };
      this.first.forEach((first, level) => {
        if (first === null) return;
        const start = this.starts[level];
        if (!start) throw new Error("InstancedLod: missing level slot offset");
        If(selected.equal(level), () => emit(level, start, t));
        // The finer neighbour fading out with it.
        If(finer.equal(level).and(t.greaterThan(0)), () => emit(level, start, t.negate()));
      });
    })().compute(count);
  }

  private handOverPass(): ComputeNode {
    const counts = storage(this.counts, "uint", 0).setName("lodCounts").toAtomic();
    return Fn(() => {
      Loop({ start: uint(0), end: this.drawCount, type: "uint", condition: "<" }, ({ i }) => {
        const draw = this.records.element(i).toVar();
        const first = uint(0).toVar();
        this.starts.forEach((value, level) => If(draw.x.equal(level), () => void first.assign(value)));
        const at = this.argsStart.add(i.mul(ARGS_BYTES / 4));
        this.arguments.element(at).assign(draw.y);
        this.arguments.element(at.add(1)).assign(atomicLoad(counts.element(draw.x)));
        this.arguments.element(at.add(2)).assign(draw.z);
        this.arguments.element(at.add(3)).assign(draw.w.equal(1).select(uint(0), first));
        this.arguments.element(at.add(4)).assign(draw.w.equal(1).select(first, uint(0)));
      });
      this.first.forEach((_, l) => atomicStore(counts.element(l), uint(0)));
    })().compute(1);
  }
}

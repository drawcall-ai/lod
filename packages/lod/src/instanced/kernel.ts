import { StorageBufferAttribute, type StorageInstancedBufferAttribute, Vector3, Vector4, type ComputeNode, type Node, type Sphere } from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  Return,
  atomicAdd,
  atomicLoad,
  atomicStore,
  distance,
  dot,
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
import { at } from "../at.js";
import { FADE } from "../levels.js";
import { maxScale, stretch } from "../tsl.js";
import { ARGS_BYTES, type ArgsSlice } from "./args.js";

// Sorting the instances of an InstancedLod into its levels, on the GPU, once per view.
//
// One thread per instance skips it outside the view's frustum, measures its height on
// screen from its matrix, the same way a Lod does on the CPU (see View: 2 r q / d, q
// pixels per unit of subtense times Lod.quality), picks its level and, near a switch, the
// finer level fading out with it (see fade.ts), and appends itself to each level it draws:
// its index and signed fade go to that level's next free slot. A shadow map is a view of
// its own, measured in its texels: each one draws only its casters, each at the level its
// texels resolve. Every level has `count` slots of one buffer, from its `first`; its draws
// start there (their first instance), so all levels share one pass, within WebGPU's
// default limit of 8 storage buffers per stage. A second pass hands each level's count to
// the indirect draws of its meshes and clears the counts for the next view. Instances at
// scale 0 draw in no level.

/** A view to select for: its aim, and the slots and draws to fill. */
export interface Target {
  readonly eye: Vector3;
  scale: number;
  ortho: boolean;
  fading: boolean;
  /** The level every instance draws, or -1. */
  forced: number;
  readonly planes: readonly Vector4[];
  readonly maxPixels: readonly number[];
  readonly indices: StorageBufferAttribute;
  readonly fades: StorageBufferAttribute;
  /** Per instance, the level it settled on drawing plus one, or 0. */
  readonly shown: StorageBufferAttribute;
  args: ArgsSlice;
}

/** One indirect draw: a level's mesh, drawing `count` indices (or vertices) from `start`. */
export interface IndirectDraw {
  level: number;
  count: number;
  start: number;
  indexed: boolean;
}

/** The two passes that select an InstancedLod's instances for a view, and the uniforms and storage they read. */
export class Kernel {
  /** Per level, its maxPixels (any finite stand-in for level 0's Infinity). */
  private readonly maxPixels: Array<{ value: number } & Node<"float">>;
  readonly progress = uniform(1);
  /** The radius around an instance's centre, in its own space, that every level and its sway stay within. */
  readonly reach = uniform(0);

  // What the view being selected sets (see `load`).
  private readonly eye = uniform(new Vector3());
  private readonly scale = uniform(0);
  private readonly ortho = uniform(0, "uint");
  private readonly fades = uniform(0, "uint");
  /** The level every instance draws, or -1. */
  private readonly forced = uniform(-1, "int");
  private readonly planes = Array.from({ length: 6 }, () => uniform(new Vector4(0, 0, 0, 1)));
  private readonly routes: Array<{ value: number } & Node<"int">>;
  private readonly previous: Array<{ value: number } & Node<"int">>;
  // Crowd dimensions are data; equal ladders share shader modules regardless of capacity.
  private readonly starts: Array<{ value: number } & Node<"uint">>;
  private readonly bounds = uniform(new Vector4());
  private readonly drawCount = uniform(0, "uint");
  private readonly records = storage(new StorageBufferAttribute(new Uint32Array(4), 4), "uvec4", 0)
    .setName("lodDraws")
    .toReadOnly();
  private readonly out = {
    indices: storage(new StorageBufferAttribute(new Uint32Array(1), 1), "uint", 0).setName("lodSlotIndices"),
    fades: storage(new StorageBufferAttribute(new Float32Array(1), 1), "float", 0).setName("lodSlotFades"),
    shown: storage(new StorageBufferAttribute(new Uint32Array(1), 1), "uint", 0).setName("lodShown"),
    arguments: storage(new StorageBufferAttribute(new Uint32Array(5), 1), "uint", 0).setName("lodDrawArgs"),
  };
  // Allocation location must not specialize the arguments pass for every crowd.
  private readonly argsStart = uniform(0, "uint");
  /** Each level's count of the view being selected. */
  private readonly counts: StorageBufferAttribute;
  private kernels: ComputeNode[] | null = null;

  constructor(
    private readonly matrices: StorageInstancedBufferAttribute,
    private readonly count: number,
    /** One instance's bounding sphere, in its own space. */
    sphere: Sphere,
    /** Per level, its first slot, or null for a level that draws nothing. */
    private readonly first: readonly (number | null)[],
    fallback: readonly number[],
  ) {
    this.starts = first.map((start) => uniform(start ?? 0, "uint"));
    this.bounds.value.set(sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius);
    this.reach.value = sphere.radius;
    this.maxPixels = first.map(() => uniform(0));
    this.counts = new StorageBufferAttribute(new Uint32Array(first.length), 1);
    this.routes = fallback.map((level) => uniform(level, "int"));
    this.previous = fallback.map((level) => uniform(level, "int"));
  }

  /** Residency is data, including the previous route for the arrival's dither fade. */
  route(fallback: readonly number[], fade: boolean): void {
    fallback.forEach((level, i) => {
      const route = at(this.routes, i);
      const previous = at(this.previous, i);
      previous.value = fade ? route.value : level;
      route.value = level;
    });
    this.progress.value = fade ? 0 : 1;
  }

  writeDraws(draws: readonly IndirectDraw[]): void {
    const values = new Uint32Array(Math.max(draws.length, 1) * 4);
    draws.forEach((draw, i) => values.set([draw.level, draw.count, draw.start, Number(draw.indexed)], i * 4));
    const previous = this.records.value;
    this.records.value = new StorageBufferAttribute(values, 4);
    this.drawCount.value = draws.length;
    previous.dispose();
  }

  /** The passes, pointed at `target`: its aim in the uniforms, its slots and draws in the storage. */
  load(target: Target): ComputeNode[] {
    this.eye.value.copy(target.eye);
    this.scale.value = target.scale;
    this.ortho.value = Number(target.ortho);
    this.fades.value = Number(target.fading);
    this.forced.value = target.forced;
    target.maxPixels.forEach((value, l) => (at(this.maxPixels, l).value = value));
    target.planes.forEach((plane, i) => at(this.planes, i).value.copy(plane));
    this.out.indices.value = target.indices;
    this.out.fades.value = target.fades;
    this.out.shown.value = target.shown;
    this.out.arguments.value = target.args.attribute;
    this.argsStart.value = target.args.offset / 4;
    this.kernels ??= [this.selectPass(), this.argumentsPass()];
    return this.kernels;
  }

  dispose(): void {
    this.counts.dispose();
    for (const kernel of this.kernels ?? []) kernel.dispose();
    this.kernels = null;
    this.records.value.dispose();
  }

  /** The pass that fills the slots. */
  private selectPass(): ComputeNode {
    const { count, out } = this;
    const matrices = storage(this.matrices, "mat4", 0).setName("lodSourceMatrices").toReadOnly();
    const counts = storage(this.counts, "uint", 0).setName("lodCounts").toAtomic();
    return Fn(() => {
      const m = matrices.element(instanceIndex).toVar();
      const r = this.bounds.w.mul(maxScale(m)).toVar();
      // What it drew last, which it keeps drawing in place of a missing level; one out of view drew nothing.
      const shown = out.shown.element(instanceIndex);
      const hide = () => {
        shown.assign(0);
        Return();
      };
      If(r.equal(0), hide);
      const centre = m.mul(vec4(this.bounds.xyz, 1)).xyz.toVar();
      // Outside the view: wholly behind one of its planes, with every level and its sway.
      const extent = this.reach.mul(stretch(m)).mul(1 + 1e-4).negate();
      for (const plane of this.planes) If(dot(plane.xyz, centre).add(plane.w).lessThan(extent), hide);
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
      // A route that draws nothing draws the level this instance kept; with none, the new route draws at once.
      const kept = int(shown).sub(1).toVar();
      If(selected.lessThan(0), () => {
        selected.assign(kept);
        finer.assign(kept);
      });
      If(before.lessThan(0), () => {
        before.assign(kept);
        beforeFiner.assign(kept);
      });
      If(before.lessThan(0), () => {
        before.assign(selected);
        beforeFiner.assign(finer);
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
      }).Else(() => void shown.assign(uint(selected.add(1))));
      const emit = (level: number, first: Node<"uint">, fade: Node<"float">) => {
        const slot = atomicAdd(counts.element(level), uint(1)).add(first).toVar();
        out.indices.element(slot).assign(instanceIndex);
        out.fades.element(slot).assign(fade);
      };
      this.first.forEach((first, level) => {
        if (first === null) return;
        const start = at(this.starts, level);
        If(selected.equal(level), () => emit(level, start, t));
        // The finer neighbour fading out with it.
        If(finer.equal(level).and(t.greaterThan(0)), () => emit(level, start, t.negate()));
      });
    })().compute(count);
  }

  private argumentsPass(): ComputeNode {
    const counts = storage(this.counts, "uint", 0).setName("lodCounts").toAtomic();
    return Fn(() => {
      Loop({ start: uint(0), end: this.drawCount, type: "uint", condition: "<" }, ({ i }) => {
        const draw = this.records.element(i).toVar();
        const first = uint(0).toVar();
        this.starts.forEach((value, level) => If(draw.x.equal(level), () => void first.assign(value)));
        const base = this.argsStart.add(i.mul(ARGS_BYTES / 4));
        const words = this.out.arguments;
        words.element(base).assign(draw.y);
        words.element(base.add(1)).assign(atomicLoad(counts.element(draw.x)));
        words.element(base.add(2)).assign(draw.z);
        words.element(base.add(3)).assign(draw.w.equal(1).select(uint(0), first));
        words.element(base.add(4)).assign(draw.w.equal(1).select(first, uint(0)));
      });
      this.first.forEach((_, l) => atomicStore(counts.element(l), uint(0)));
    })().compute(1);
  }
}

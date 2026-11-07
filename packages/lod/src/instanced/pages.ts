import {
  type Box3,
  type ComputeNode,
  IndirectStorageBufferAttribute,
  type Node,
  StorageBufferAttribute,
  type StorageInstancedBufferAttribute,
  type Renderer,
} from "three/webgpu";
import {
  Break,
  Fn,
  If,
  Loop,
  atomicAdd,
  atomicLoad,
  atomicStore,
  atomicSub,
  code,
  computeKernel,
  localId,
  storage,
  storageBarrier,
  uint,
  uvec2,
  uvec4,
  wgslFn,
  workgroupId,
} from "three/tsl";
import { type TgpuFn, d } from "typegpu";
import { at } from "../at.js";
import { upload } from "./dirty.js";
import { Records } from "./records.js";

// Instances a GPU pass of the app produces, never read back: each chunk's records are turned into instances on the
// GPU, into fixed-size pages of a pool, and the selection reads them where they land (see kernel.ts).
//
// In the first render after chunks were added or removed, ahead of any selection, four passes run. One workgroup walks
// the chunk slots: every removed or replaced chunk pushes its pages back on the free stack, then every new chunk lists
// its records, a window of up to `PAGE` per job. A pass with one workgroup per job counts the window's survivors, the
// records whose instance has a keep ratio below 1. One workgroup then gives every new chunk the pages its survivors
// need and writes each page's fill, turning its windows' counts into where their survivors start. A last pass with one
// workgroup per job runs the app's instance function again and writes each survivor into its place, so a chunk's
// instances fill its pages in order and a record that makes no instance costs no room. That render is the only time a
// chunk's records are read, so the producer may reuse them right after. A chunk that finds the stack short keeps the
// pages it got, its instances clamped to them, until it is removed; `drained` reports it. The CPU never learns a
// count: it knows only which slots hold chunks, and the GPU knows what each got.

/** Instances per page: the selection runs one workgroup per page. */
export const PAGE = 256;

/** What a GPU chunk's instance function returns for a record: see `GpuChunks.instance`. */
export const GpuInstance = d.struct({
  /** The instance's matrix in the InstancedLod's space, as `setMatrixAt` takes it. */
  matrix: d.mat4x4f,
  /** Its tint, as `setColorAt` takes it. */
  color: d.vec3f,
  /** Its keep ratio in [0, 1) (see `InstancedRange`); 1 or more makes no instance, and the record takes no room in the pool. */
  keep: d.f32,
});

/** A storage buffer the app's GPU pass writes. */
type Storage = StorageBufferAttribute | StorageInstancedBufferAttribute;

/** How an InstancedLod takes chunks of instances that the app's GPU passes produce (see `InstancedLod.addGpuChunk`). */
export interface GpuChunks {
  /**
   * The instance a record stands for, a pure function of the record's words: a record is a fixed number of `vec4u`
   * words, which the app's pass packs and this function unpacks. Derive what varies per instance (scale, rotation,
   * tint, keep ratio) from a hash the record carries, not from where it lies: records arrive in any order.
   */
  instance: TgpuFn<(...words: d.Vec4u[]) => typeof GpuInstance>;
  /** Where chunks' records lie, `vec4u` items, a record's words in a row; read only in the render that takes a chunk in. */
  records: Storage;
  /** Where chunks' record counts lie, `u32` items; read only in the render that takes a chunk in. */
  counts: Storage;
  /** The most records a chunk holds: more are ignored. */
  capacity: number;
  /** The least and the most any instance matrix scales along its longest axis: what level loading is judged by. */
  scales: readonly [number, number];
  /** Pages of `PAGE` instances in the pool: its instances at most; a chunk added to a full pool lacks instances. 512 by default. */
  pages?: number;
  /** The most chunks held at once. 256 by default. */
  slots?: number;
}

/** A GPU chunk to add: where its records and count lie, and where its instances stand. */
export interface GpuChunkData {
  /** Encloses every instance's origin, in the InstancedLod's space. */
  box: Box3;
  /** Its first record in `GpuChunks.records`, counted in records. */
  first: number;
  /** Its count's index in `GpuChunks.counts`. */
  counter: number;
}

/** Instances added to an InstancedLod from the GPU in one call and removed whole. */
export interface GpuChunk extends Readonly<GpuChunkData> {
  readonly slot: number;
}

/** The instance buffers the pages fill: a selection's. */
interface Targets {
  readonly matrices: StorageInstancedBufferAttribute;
  readonly keeps: StorageBufferAttribute;
  readonly colors: StorageInstancedBufferAttribute | null;
}

/** The page pool of an InstancedLod fed by GPU chunks, and the passes that fill and free it. */
export class Pages {
  /** Places for instances: every page's. */
  readonly capacity: number;
  /** The pool's instance data before the GPU writes it: zeros, colours white. */
  readonly matrices: Float32Array;
  readonly keeps: Float32Array;
  readonly colors: Float32Array;
  /** Per page, how many of its places hold an instance. */
  readonly fills: StorageBufferAttribute;
  readonly chunks = new Set<GpuChunk>();
  /** The most chunks held at once. */
  readonly slotCount: number;
  /** The page ids a slot can hold, and the windows of `PAGE` records its chunk can have. */
  private readonly perSlot: number;
  private readonly records: Records;
  /** The free page count, then the free page ids. */
  private readonly stack: StorageBufferAttribute;
  /** Per slot, the ids of the pages it holds. */
  private readonly table: StorageBufferAttribute;
  /** Per slot and window of its records, the window's survivors, then where they start among the chunk's instances. */
  private readonly windows: StorageBufferAttribute;
  /** Per slot, written by the CPU: whether it holds a chunk, the chunk's first record, its counter and generation. */
  private readonly sources: StorageBufferAttribute;
  /** Per slot, written by the GPU: the generation it got to, its pages, its instances and the pages it needs. */
  private readonly states: StorageBufferAttribute;
  /** The windows of records to take in this frame: first record, slot, records, window. */
  private readonly jobs: StorageBufferAttribute;
  private readonly dispatch = new IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1);
  /** Per slot, the generation of the chunk it last took: a slot reused in one frame still frees its pages. */
  private readonly generations: Uint32Array;
  private readonly free: number[] = [];
  private kernels: { list: ComputeNode; count: ComputeNode; allocate: ComputeNode; copy: ComputeNode } | null = null;
  /** Whether chunks changed since the passes last ran. */
  private pending = false;
  /** Bumped whenever chunks change. */
  private version = 0;

  constructor(private readonly options: GpuChunks) {
    const { capacity, scales, records, counts, instance } = options;
    const pages = options.pages ?? 512;
    this.slotCount = options.slots ?? 256;
    this.records = new Records(instance, records);
    for (const [name, value] of [
      ["pages", pages],
      ["slots", this.slotCount],
      ["capacity", capacity],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) throw new RangeError(`InstancedLod: gpuChunks.${name} must be a positive integer, got ${value}`);
    }
    if (!(scales[0] > 0 && scales[0] <= scales[1] && Number.isFinite(scales[1])))
      throw new RangeError(`InstancedLod: gpuChunks.scales must be 0 < min <= max, got ${scales.join(", ")}`);
    if (!(records.array instanceof Uint32Array) || records.itemSize !== 4) throw new TypeError("InstancedLod: gpuChunks.records must hold vec4u items");
    if (!(counts.array instanceof Uint32Array) || counts.itemSize !== 1) throw new TypeError("InstancedLod: gpuChunks.counts must hold u32 items");
    this.capacity = pages * PAGE;
    this.perSlot = Math.ceil(capacity / PAGE);
    this.matrices = new Float32Array(this.capacity * 16);
    this.keeps = new Float32Array(this.capacity);
    this.colors = new Float32Array(this.capacity * 4).fill(1);
    this.fills = new StorageBufferAttribute(new Uint32Array(pages), 1);
    // Popped from the end: page 0 first.
    const stack = new Uint32Array(pages + 1);
    stack[0] = pages;
    for (let i = 0; i < pages; i++) stack[i + 1] = pages - 1 - i;
    this.stack = new StorageBufferAttribute(stack, 1);
    this.table = new StorageBufferAttribute(new Uint32Array(this.slotCount * this.perSlot), 1);
    this.windows = new StorageBufferAttribute(new Uint32Array(this.slotCount * this.perSlot), 1);
    this.sources = new StorageBufferAttribute(new Uint32Array(this.slotCount * 4), 4);
    this.states = new StorageBufferAttribute(new Uint32Array(this.slotCount * 4), 4);
    this.jobs = new StorageBufferAttribute(new Uint32Array(this.slotCount * this.perSlot * 4), 4);
    this.generations = new Uint32Array(this.slotCount);
    for (let slot = this.slotCount - 1; slot >= 0; slot--) this.free.push(slot);
  }

  get scales(): readonly [number, number] {
    return this.options.scales;
  }

  /** Take `data` into a free slot; its records turn into instances before the next selection. */
  add(data: GpuChunkData): GpuChunk {
    const { box, first, counter } = data;
    if (!Number.isInteger(first) || first < 0) throw new RangeError(`InstancedLod: a GPU chunk's first record must be an integer >= 0, got ${first}`);
    if (!Number.isInteger(counter) || counter < 0) throw new RangeError(`InstancedLod: a GPU chunk's counter must be an integer >= 0, got ${counter}`);
    const { records, counts, capacity } = this.options;
    if ((first + capacity) * this.records.words > records.count)
      throw new RangeError(`InstancedLod: a GPU chunk's records from ${first} on, up to gpuChunks.capacity of them, pass the end of gpuChunks.records`);
    if (counter >= counts.count) throw new RangeError(`InstancedLod: a GPU chunk's counter ${counter} passes the end of gpuChunks.counts`);
    const slot = this.free.pop();
    if (slot === undefined) throw new Error(`InstancedLod: all ${this.slotCount} GPU chunk slots are taken (see gpuChunks.slots)`);
    const generation = at(this.generations, slot) + 1;
    this.generations[slot] = generation;
    this.write(slot, [1, first, counter, generation]);
    const chunk: GpuChunk = { box: box.clone(), first, counter, slot };
    this.chunks.add(chunk);
    return chunk;
  }

  /** Free `chunk`'s slot; its pages go back to the pool before the next selection. */
  remove(chunk: GpuChunk): void {
    if (!this.chunks.delete(chunk)) throw new Error("InstancedLod: the GPU chunk is not one of its own");
    this.write(chunk.slot, [0, 0, 0, at(this.generations, chunk.slot)]);
    this.free.push(chunk.slot);
  }

  private write(slot: number, values: readonly number[]): void {
    this.sources.array.set(values, slot * 4);
    upload(this.sources, slot, slot + 1);
    this.sources.needsUpdate = true;
    this.pending = true;
    this.version++;
  }

  /** Take in the chunks' changes on `renderer`, writing instances into `targets`, if they changed since the last run: in the render after they change. */
  run(renderer: Renderer, targets: Targets): void {
    if (!this.pending) return;
    this.pending = false;
    if (!this.kernels) {
      this.kernels = { list: this.listPass(), count: this.countPass(), allocate: this.allocatePass(), copy: this.copyPass(targets) };
    }
    const { list, count, allocate, copy } = this.kernels;
    renderer.compute(list);
    renderer.compute(count, this.dispatch);
    renderer.compute(allocate);
    renderer.compute(copy, this.dispatch);
  }

  /**
   * Whether every chunk has been taken in: false while changes wait for the passes or chunks changed meanwhile. Throws
   * if a chunk lacks pages. Reads the GPU's progress back.
   */
  async drained(renderer: Renderer): Promise<boolean> {
    if (this.pending) return false;
    if (this.chunks.size === 0) return true;
    const version = this.version;
    const states = new Uint32Array(await renderer.getArrayBufferAsync(this.states));
    if (version !== this.version) return false;
    let short = 0;
    let held = 0;
    let needed = 0;
    for (const { slot } of this.chunks) {
      const base = slot * 4;
      if (states[base] !== this.generations[slot]) return false;
      if (at(states, base + 1) === at(states, base + 3)) continue;
      short++;
      held += at(states, base + 1);
      needed += at(states, base + 3);
    }
    if (short > 0) {
      throw new Error(
        `InstancedLod: ${short} GPU chunk${short === 1 ? "" : "s"} lack pages, holding ${held} of the ${needed} pages they need: raise gpuChunks.pages (now ${this.fills.count})`,
      );
    }
    return true;
  }

  dispose(): void {
    for (const attribute of [this.fills, this.stack, this.table, this.windows, this.sources, this.states, this.jobs, this.dispatch]) attribute.dispose();
    for (const kernel of Object.values(this.kernels ?? {})) kernel.dispose();
    this.kernels = null;
  }

  /** The pool's buffers as one pass uses them: a node each, since a pass may not bind a buffer it writes twice. */
  private nodes() {
    const { slotCount: slots, perSlot } = this;
    const pages = this.fills.count;
    const { counts } = this.options;
    return {
      stack: storage(this.stack, "uint", pages + 1).toAtomic(),
      table: storage(this.table, "uint", slots * perSlot),
      windows: storage(this.windows, "uint", slots * perSlot),
      sources: storage(this.sources, "uvec4", slots).toReadOnly(),
      states: storage(this.states, "uvec4", slots),
      fills: storage(this.fills, "uint", pages),
      jobs: storage(this.jobs, "uvec4", slots * perSlot),
      listed: storage(this.dispatch, "uint", 3).toAtomic().element(0),
      counts: storage(counts, "uint", counts.count).toReadOnly(),
    };
  }

  /** `body` for every chunk slot, in a pass of one workgroup, its lanes taking every `PAGE`th slot. */
  private eachSlot(body: (slot: Node<"uint">) => void): void {
    Loop({ start: uint(0), end: uint(Math.ceil(this.slotCount / PAGE)), type: "uint", condition: "<" }, ({ i }) => {
      const slot = i.mul(PAGE).add(localId.x).toVar();
      If(slot.lessThan(this.slotCount), () => body(slot));
    });
  }

  /** `body` for `slot` if it holds a chunk added since the last run, with the chunk's source and record count. */
  private ifNew(nodes: Nodes, slot: Node<"uint">, body: (source: Node<"uvec4">, records: Node<"uint">) => void): void {
    const source = nodes.sources.element(slot).toVar();
    const state = nodes.states.element(slot).toVar();
    If(source.x.equal(1).and(state.x.notEqual(source.w)), () => body(source, least(nodes.counts.element(source.z), uint(this.options.capacity)).toVar()));
  }

  /** The pass that frees the pages of removed chunks, then lists new chunks' records as jobs: one workgroup. */
  private listPass(): ComputeNode {
    const { perSlot } = this;
    const nodes = this.nodes();
    const { stack, table, states, fills, jobs, listed } = nodes;
    const top = stack.element(0);
    return workgroups(() => {
      If(localId.x.equal(0), () => void atomicStore(listed, uint(0)));
      // A removed chunk, or one replaced since the last run, frees every page it held.
      this.eachSlot((slot) => {
        const source = nodes.sources.element(slot).toVar();
        const state = states.element(slot).toVar();
        If(source.x.equal(0).or(state.x.notEqual(source.w)), () => {
          Loop({ start: uint(0), end: state.y, type: "uint", condition: "<" }, ({ i }) => {
            const page = table.element(slot.mul(perSlot).add(i)).toVar();
            fills.element(page).assign(0);
            atomicStore(stack.element(atomicAdd(top, uint(1)).add(1)), page);
          });
          states.element(slot).assign(uvec4(0));
        });
      });
      storageBarrier();
      this.eachSlot((slot) =>
        this.ifNew(nodes, slot, (source, records) => {
          Loop({ start: uint(0), end: records.add(PAGE - 1).div(PAGE), type: "uint", condition: "<" }, ({ i }) => {
            const window = uvec4(source.y.add(i.mul(PAGE)), slot, least(records.sub(i.mul(PAGE)), uint(PAGE)), i);
            jobs.element(atomicAdd(listed, uint(1))).assign(window);
          });
        }),
      );
    });
  }

  /** The pass that counts each job's survivors: one workgroup per job. */
  private countPass(): ComputeNode {
    const { perSlot, records } = this;
    const { jobs, windows } = this.nodes();
    return workgroups(() => {
      const job = jobs.element(workgroupId.x).toVar();
      const { total } = rank(records.keepAt(job).lessThan(1));
      If(localId.x.equal(0), () => void windows.element(job.y.mul(perSlot).add(job.w)).assign(total));
    });
  }

  /**
   * The pass that gives new chunks the pages their survivors need, writes the pages' fills and turns the chunks' window
   * counts into where their survivors start: one workgroup. Under a short stack, which chunks get its last pages is a race.
   */
  private allocatePass(): ComputeNode {
    const { perSlot } = this;
    const pages = this.fills.count;
    const nodes = this.nodes();
    const { stack, table, windows, states, fills } = nodes;
    const top = stack.element(0);
    return workgroups(() =>
      this.eachSlot((slot) =>
        this.ifNew(nodes, slot, (source, records) => {
          const survivors = uint(0).toVar();
          Loop({ start: uint(0), end: records.add(PAGE - 1).div(PAGE), type: "uint", condition: "<" }, ({ i }) => {
            const window = windows.element(slot.mul(perSlot).add(i));
            const counted = window.toVar();
            window.assign(survivors);
            survivors.addAssign(counted);
          });
          const need = survivors
            .add(PAGE - 1)
            .div(PAGE)
            .toVar();
          const held = uint(0).toVar();
          Loop({ start: uint(0), end: need, type: "uint", condition: "<" }, ({ i }) => {
            // The page under the top before taking it; none when the stack ran dry, its count wrapped past 0.
            const before = atomicSub(top, uint(1)).toVar();
            If(before.sub(1).greaterThanEqual(pages), () => {
              atomicAdd(top, uint(1));
              Break();
            });
            const page = atomicLoad(stack.element(before)).toVar();
            table.element(slot.mul(perSlot).add(i)).assign(page);
            fills.element(page).assign(least(survivors.sub(i.mul(PAGE)), uint(PAGE)));
            held.addAssign(1);
          });
          states.element(slot).assign(uvec4(source.w, held, least(survivors, held.mul(PAGE)), need));
        }),
      ),
    );
  }

  /** The pass that writes each job's survivors into their places in their chunk's pages: one workgroup per job. */
  private copyPass(targets: Targets): ComputeNode {
    const { capacity, perSlot, records } = this;
    const { jobs, windows, table, states } = this.nodes();
    const matrices = storage(targets.matrices, "mat4", capacity);
    const keeps = storage(targets.keeps, "float", capacity);
    if (!targets.colors) throw new Error("InstancedLod: GPU chunks need the selection's colours");
    const colors = storage(targets.colors, "vec4", capacity);
    return workgroups(() => {
      const job = jobs.element(workgroupId.x).toVar();
      const keep = records.keepAt(job);
      const survives = keep.lessThan(1);
      const { before } = rank(survives);
      const base = job.y.mul(perSlot);
      const place = windows.element(base.add(job.w)).add(before).toVar();
      // Survivors past the pages the chunk got are left out.
      If(survives.and(place.lessThan(states.element(job.y).y.mul(PAGE))), () => {
        const index = table
          .element(base.add(place.div(PAGE)))
          .mul(PAGE)
          .add(place.mod(PAGE))
          .toVar();
        matrices.element(index).assign(records.matrixAt(job));
        colors.element(index).assign(records.colorAt(job));
        keeps.element(index).assign(keep);
      });
    });
  }
}

type Nodes = ReturnType<Pages["nodes"]>;

/**
 * A pass of workgroups of `PAGE` lanes: one, unless dispatched with the jobs listed. A dispatch size rather than a
 * count: a count adds an early return, which a barrier may not follow.
 */
function workgroups(body: () => void): ComputeNode {
  const node = computeKernel(Fn(body)(), [PAGE]);
  node.dispatchSize = [1, 1, 1];
  return node;
}

/**
 * Across a workgroup of `PAGE` lanes: how many lanes before this one are `chosen`, and how many are in all. Every lane
 * calls it, outside any branch: it waits for the others. Hillis–Steele: after the step of width w, each lane holds the
 * sum of the 2w lanes up to it.
 */
const rankOf = wgslFn(
  `fn lodRank(lane: u32, chosen: u32) -> vec2u {
  lodRankSums[lane] = chosen;
  for (var width = 1u; width < ${PAGE}u; width *= 2u) {
    workgroupBarrier();
    var sum = lodRankSums[lane];
    if (lane >= width) { sum += lodRankSums[lane - width]; }
    workgroupBarrier();
    lodRankSums[lane] = sum;
  }
  workgroupBarrier();
  return vec2u(lodRankSums[lane] - chosen, lodRankSums[${PAGE - 1}]);
}`,
  [code(`var<workgroup> lodRankSums: array<u32, ${PAGE}>;`)],
);

function rank(chosen: Node<"bool">) {
  const ranked = uvec2(0).toVar();
  ranked.assign(rankOf({ lane: localId.x, chosen: chosen.select(uint(1), uint(0)) }));
  return { before: ranked.x, total: ranked.y };
}

/** The lesser of two uints. */
const least = (a: Node<"uint">, b: Node<"uint">) => a.lessThan(b).select(a, b);

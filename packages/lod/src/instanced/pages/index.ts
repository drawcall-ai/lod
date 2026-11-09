import { type Box3, type ComputeNode, IndirectStorageBufferAttribute, type Renderer, StorageBufferAttribute, type StorageInstancedBufferAttribute } from "three/webgpu";
import { type TgpuFn, d } from "typegpu";
import { at } from "../../at.js";
import { Blocks } from "../blocks.js";
import { upload } from "../dirty.js";
import type { BlockFrame, Places, Seed } from "../places.js";
import type { Selection } from "../select.js";
import { allocatePass, clearPass, copyPass, countPass, listPass, occupyPass, type Pool } from "./passes.js";
import { Records } from "./records.js";
import { PAGE } from "./workgroup.js";

export { PAGE };

// Instances a GPU pass of the app produces, never read back: each chunk's records are turned into instances on the
// GPU, into fixed-size pages of a pool, and the selection visits the pages chunks hold (see kernel.ts).
//
// In the first render after chunks were added or removed, ahead of any selection, these passes run (see passes.ts).
// One workgroup walks the chunk slots: every removed or replaced chunk pushes its pages back on the free stack, then
// every new chunk lists its records, a window of up to `PAGE` per job. A pass with one workgroup per job counts the
// window's survivors, the records whose instance has a keep ratio below 1. One workgroup then gives every new chunk the
// pages its survivors need, turning its windows' counts into where their survivors start, and lists the pages it
// handed out, and one lists every page chunks hold. A pass with one workgroup per job runs the app's instance function again and
// writes each survivor into its place, so a chunk's instances fill its pages in order, a record that makes no instance
// costs no room, and the places past its last instance draw nothing. Last, each view forgets what it drew at the pages
// handed out. That render is the only time a chunk's records are read, so the producer may reuse them right after. A
// chunk that finds the stack short keeps the pages it got, its instances clamped to them, until it is removed;
// `drained` reports it. The CPU never learns a count: it knows only which slots hold chunks, and the GPU knows what
// each got.

/** What a GPU chunk's instance function returns for a record: see `GpuRecords.instance`. */
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

/** The records an InstancedLod's GPU chunks come from, which the app's GPU passes write (see `InstancedLod.addGpuChunk`). */
export interface GpuRecords {
  /**
   * The instance a record stands for, a pure function of the record's words: a record is a fixed number of `vec4u`
   * words, which the app's pass packs and this function unpacks. Derive what varies per instance (scale, rotation,
   * tint, keep ratio) from a hash the record carries, not from where it lies: records arrive in any order.
   */
  instance: TgpuFn<(...words: d.Vec4u[]) => typeof GpuInstance>;
  /** Where chunks' records lie, `vec4u` items, a record's words in a row; read only in the render that takes a chunk in. */
  records: Storage;
  /** Where chunks' record counts lie, `u32` items; read only in the render that takes a chunk in. */
  counters: Storage;
  /** The most records a chunk holds: more are ignored. */
  capacity: number;
  /** The least and the most any instance matrix scales along its longest axis: what level loading is judged by. */
  scales: readonly [number, number];
  /** The most instances held at once: the pool has pages for them and a part-filled page per chunk; a chunk added to a full pool lacks instances. `256 * PAGE` by default. */
  instances?: number;
  /** The most chunks held at once. 256 by default. */
  chunks?: number;
}

/** A GPU chunk to add: where its records and count lie, and where its instances stand. */
export interface GpuChunkData {
  /** Encloses every instance's origin, in the InstancedLod's space. */
  box: Box3;
  /** Its first record in `GpuRecords.records`, counted in records. */
  first: number;
  /** Its count's index in `GpuRecords.counters`. */
  counter: number;
}

/** Instances added to an InstancedLod from the GPU in one call and removed whole. */
export interface GpuChunk extends Readonly<GpuChunkData> {
  readonly slot: number;
}

/** The page pool of an InstancedLod fed by GPU chunks, and the passes that fill and free it. */
export class Pages implements Places {
  readonly capacity: number;
  readonly end: number;
  readonly occupied: Places["occupied"];
  readonly chunks = new Set<GpuChunk>();
  private readonly pool: Pool;
  private readonly records: Records;
  /** Per slot, the generation of the chunk it last took: a slot reused in one frame still frees its pages. */
  private readonly generations: Uint32Array;
  private readonly free: number[] = [];
  private selection: Selection | null = null;
  private kernels: { list: ComputeNode; count: ComputeNode; allocate: ComputeNode; occupy: ComputeNode; copy: ComputeNode; clear: ReturnType<typeof clearPass> } | null = null;
  /** Whether chunks changed since the passes last ran. */
  private pending = false;
  /** Bumped whenever chunks change. */
  private version = 0;
  /** Whether the selection's buffers dropped the CPU arrays they were made from. */
  private released = false;

  constructor(private readonly options: GpuRecords) {
    const { capacity, scales, records, counters, instance, instances = 256 * PAGE, chunks: slots = 256 } = options;
    for (const [name, value] of [
      ["instances", instances],
      ["chunks", slots],
      ["capacity", capacity],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) throw new RangeError(`InstancedLod: gpuRecords.${name} must be a positive integer, got ${value}`);
    }
    if (!(scales[0] > 0 && scales[0] <= scales[1] && Number.isFinite(scales[1]))) throw new RangeError(`InstancedLod: gpuRecords.scales must be 0 < min <= max, got ${scales.join(", ")}`);
    if (!(records.array instanceof Uint32Array) || records.itemSize !== 4) throw new TypeError("InstancedLod: gpuRecords.records must hold vec4u items");
    if (!(counters.array instanceof Uint32Array) || counters.itemSize !== 1) throw new TypeError("InstancedLod: gpuRecords.counters must hold u32 items");
    const pages = slots + Math.ceil(instances / PAGE);
    this.records = new Records(instance, records);
    this.capacity = this.end = pages * PAGE;
    const perSlot = Math.ceil(capacity / PAGE);
    // Popped from the end: page 0 first.
    const stack = new Uint32Array(pages + 1);
    stack[0] = pages;
    for (let i = 0; i < pages; i++) stack[i + 1] = pages - 1 - i;
    const words = (length: number, itemSize = 1) => new StorageBufferAttribute(new Uint32Array(length * itemSize), itemSize);
    const dispatch = () => new IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1);
    this.pool = {
      pages,
      slots,
      perSlot,
      capacity,
      stack: new StorageBufferAttribute(stack, 1),
      table: words(slots * perSlot),
      windows: words(slots * perSlot),
      sources: words(slots, 4),
      states: words(slots, 4),
      jobs: words(slots * perSlot, 4),
      jobDispatch: dispatch(),
      fresh: words(pages),
      freshDispatch: dispatch(),
      occupied: words(pages),
      occupiedDispatch: dispatch(),
      counters,
    };
    this.occupied = { pages: this.pool.occupied, dispatch: this.pool.occupiedDispatch };
    this.generations = new Uint32Array(slots);
    for (let slot = slots - 1; slot >= 0; slot--) this.free.push(slot);
  }

  get scales(): readonly [number, number] {
    return this.options.scales;
  }

  /**
   * Zeros, which the selection's buffers own: a place holds an instance only once the copy pass wrote one. `release`
   * empties them once the GPU holds them.
   */
  seed(): Seed {
    const { capacity } = this;
    return { matrices: new Float32Array(capacity * 16), keeps: new Float32Array(capacity), colors: new Float32Array(capacity * 4) };
  }

  /** A leaf per chunk slot, around the origins in its box at its scales; a chunk's survivors may draw as large as any. */
  blocks(frame: BlockFrame, survivors: boolean): Blocks {
    const { slots } = this.pool;
    const blocks = new Blocks(slots, new Float32Array(slots * 4), frame.source, frame.bounds, frame.draws, frame.rest, survivors ? new Float32Array(slots) : null, 1);
    blocks.pad(frame.padding);
    for (const chunk of this.chunks) blocks.place(chunk.slot, chunk.box, this.scales);
    blocks.refit();
    return blocks;
  }

  attach(selection: Selection | null): void {
    this.selection = selection;
  }

  /** Nothing to measure: chunks place their boxes as they come and go. */
  measure(): void {}

  /** Take `data` into a free slot; its records turn into instances before the next selection. */
  add(data: GpuChunkData): GpuChunk {
    const { box, first, counter } = data;
    if (!Number.isInteger(first) || first < 0) throw new RangeError(`InstancedLod: a GPU chunk's first record must be an integer >= 0, got ${first}`);
    if (!Number.isInteger(counter) || counter < 0) throw new RangeError(`InstancedLod: a GPU chunk's counter must be an integer >= 0, got ${counter}`);
    const { records, counters, capacity } = this.options;
    if ((first + capacity) * this.records.words > records.count) throw new RangeError(`InstancedLod: a GPU chunk's records from ${first} on, up to gpuRecords.capacity of them, pass the end of gpuRecords.records`);
    if (counter >= counters.count) throw new RangeError(`InstancedLod: a GPU chunk's counter ${counter} passes the end of gpuRecords.counters`);
    const slot = this.free.pop();
    if (slot === undefined) throw new Error(`InstancedLod: all ${this.pool.slots} GPU chunk slots are taken (see gpuRecords.chunks)`);
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
    const { sources } = this.pool;
    sources.array.set(values, slot * 4);
    upload(sources, slot, slot + 1);
    this.pending = true;
    this.version++;
  }

  /** Take in the chunks' changes on `renderer`, if they changed since the last run: in the render after they change. */
  prepare(renderer: Renderer): void {
    if (!this.pending) return;
    const { selection, pool } = this;
    if (!selection) throw new Error("InstancedLod: GPU chunks need a selection to fill");
    this.pending = false;
    this.kernels ??= {
      list: listPass(pool),
      count: countPass(pool, this.records),
      allocate: allocatePass(pool),
      occupy: occupyPass(pool),
      copy: copyPass(pool, this.records, selection),
      clear: clearPass(pool),
    };
    const { list, count, allocate, occupy, copy, clear } = this.kernels;
    renderer.compute(list);
    renderer.compute(count, pool.jobDispatch);
    renderer.compute(allocate);
    renderer.compute(occupy);
    renderer.compute(copy, pool.jobDispatch);
    for (const shown of selection.shown()) {
      clear.shown.value = shown;
      renderer.compute(clear.pass, pool.freshDispatch);
    }
    this.release(renderer, selection);
  }

  /**
   * Drop the CPU arrays the selection's instance buffers were made from, once the GPU holds them: only the GPU writes
   * them, so they are never read again, and they are most of what a pool costs on the CPU. A buffer keeps its count.
   * This relies on three never uploading these attributes again: nothing marks them for an update, and a buffer is
   * made once.
   */
  private release(renderer: Renderer, selection: Selection): void {
    // An initialised renderer creates a pass's buffers as it runs the pass.
    if (this.released || !renderer.initialized) return;
    this.released = true;
    for (const attribute of [selection.matrices, selection.keeps, selection.colors]) if (attribute) attribute.array = new Float32Array(0);
  }

  /**
   * Whether every chunk has been taken in: false while changes wait for the passes or chunks changed meanwhile. Throws
   * if a chunk lacks pages. Reads the GPU's progress back.
   */
  async drained(renderer: Renderer): Promise<boolean> {
    if (this.pending) return false;
    if (this.chunks.size === 0) return true;
    const version = this.version;
    const states = new Uint32Array(await renderer.getArrayBufferAsync(this.pool.states));
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
        `InstancedLod: ${short} GPU chunk${short === 1 ? "" : "s"} lack pages, holding ${held} of the ${needed} pages they need: raise gpuRecords.instances (the pool has ${this.pool.pages} pages)`,
      );
    }
    return true;
  }

  dispose(): void {
    const { pool } = this;
    for (const attribute of [
      pool.stack,
      pool.table,
      pool.windows,
      pool.sources,
      pool.states,
      pool.jobs,
      pool.jobDispatch,
      pool.fresh,
      pool.freshDispatch,
      pool.occupied,
      pool.occupiedDispatch,
    ])
      attribute.dispose();
    const kernels = this.kernels;
    if (kernels) for (const kernel of [kernels.list, kernels.count, kernels.allocate, kernels.occupy, kernels.copy, kernels.clear.pass]) kernel.dispose();
    this.kernels = null;
  }
}

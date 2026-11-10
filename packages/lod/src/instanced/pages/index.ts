import { type Renderer, StorageBufferAttribute, StorageInstancedBufferAttribute } from "three/webgpu";
import { at } from "../../at.js";
import { PAGE_BITS, type PoolBuffers } from "./buffers.js";
import type { Attributes, ChunkRange } from "./chunk.js";
import { PoolPasses } from "./passes.js";
import { PAGE } from "./workgroup.js";

// Every instance of every InstancedLod of a LodGpu lives in its page pool: fixed pages of `PAGE` instances, which chunks,
// from the CPU or the GPU, are copied into, and which updateInstance visits one workgroup per page (see update.ts).
//
// In the first render after chunks were added, changed or removed, these passes run: one workgroup
// walks the chunk slots and pushes every removed or changed chunk's pages back on the free stack; per chunk taken in, a
// pass with one workgroup per window of `PAGE` of its range counts the window's instances, those at a scale above 0 (an
// app's pass marks "no instance" with scale 0); one workgroup then gives every such chunk the pages its instances need,
// turning its windows' counts into where their instances start; per chunk again, a pass writes each instance into its
// page, so a chunk's instances fill its pages in order, a spot without an instance costs no room, and the room past its
// last instance draws nothing; last, one workgroup lists every page chunks hold, with its InstancedLod's row. That
// render is the only time a chunk's attributes are read. A chunk that finds the stack short holds the pages it got, its
// instances clamped to them, until it is removed; `status` reports it. The CPU never learns a count: it knows only
// which slots hold chunks and which windows they count in, and the GPU knows what each got.

/** Windows of `PAGE` spots per page of instances that chunks may span: chunks hold far more spots than instances. */
const WINDOWS_PER_PAGE = 16;

/** WebGPU's guaranteed maxStorageBufferBindingSize: the pool's matrices are one binding. */
const MAX_BINDING = 128 * 2 ** 20;

/** A chunk to take in: its attributes and its range of them, where its instance count lies, and its InstancedLod's row. */
export interface PoolChunk extends Pick<ChunkRange, "start" | "count" | "countIndex"> {
  readonly attributes: Attributes;
  readonly row: number;
}

/** A slot's chunk and the windows it counts in. */
interface Held {
  readonly chunk: PoolChunk;
  readonly base: number;
  readonly windows: number;
}

/** A run of free windows. */
interface Run {
  first: number;
  count: number;
}

/** The page pool of a LodGpu, and the passes that fill and free it. */
export class InstancePagePool {
  /** Room for instances, in pages of `PAGE`. */
  readonly capacity: number;
  readonly pages: number;
  /** How many pages chunks hold, then per page held its id and its InstancedLod's row (see `PAGE_BITS`). */
  readonly occupied: StorageBufferAttribute;
  /** Bumped whenever the passes ran: what the pages hold changed. */
  version = 0;
  private readonly pool: PoolBuffers;
  private passes: PoolPasses | null = null;
  /** Per slot, its chunk and windows, and the generation of the chunk it last took: a slot reused in one frame still frees its pages. */
  private readonly held: (Held | null)[];
  private readonly generations: Uint32Array;
  private readonly free: number[] = [];
  /** The windows no chunk counts in, and those of chunks removed, free once the passes freed their pages. */
  private windows: Run[];
  private releasing: Run[] = [];
  /** The slots whose chunks are taken in at the next run, and whether a chunk was removed since the last. */
  private readonly due = new Set<number>();
  private removed = false;
  /** The last read of the chunks' states, and the run it followed. */
  private read: { version: number; promise: Promise<Uint32Array> } | null = null;
  /** Whether the pool's CPU arrays were dropped (see `releaseArrays`). */
  private released = false;

  constructor(
    /** The most instances held at once. */
    maxInstanceCount: number,
    /** The most chunks held at once. */
    maxChunkCount: number,
  ) {
    for (const [name, value] of [
      ["maxInstanceCount", maxInstanceCount],
      ["maxChunkCount", maxChunkCount],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) throw new RangeError(`LodGpu: ${name} must be a positive integer, got ${value}`);
    }
    // A part-filled page per chunk besides the pages that fill.
    const pages = maxChunkCount + Math.ceil(maxInstanceCount / PAGE);
    if (pages >= 2 ** PAGE_BITS)
      throw new RangeError(`LodGpu: ${pages} pages of ${PAGE} instances outgrow the ${2 ** PAGE_BITS} a pool lists: lower maxInstanceCount or maxChunkCount`);
    if (pages * PAGE * 64 > MAX_BINDING)
      throw new RangeError(
        `LodGpu: the matrices of ${pages} pages of ${PAGE} instances outgrow a storage binding of ${MAX_BINDING} bytes: lower maxInstanceCount or maxChunkCount`,
      );
    const windows = WINDOWS_PER_PAGE * pages;
    this.pages = pages;
    this.capacity = pages * PAGE;
    // Popped from the end: page 0 first.
    const stack = new Uint32Array(pages + 1);
    stack[0] = pages;
    for (let i = 0; i < pages; i++) stack[i + 1] = pages - 1 - i;
    const words = (length: number, itemSize = 1) => new StorageBufferAttribute(new Uint32Array(length * itemSize), itemSize);
    this.pool = {
      pages,
      slots: maxChunkCount,
      stack: new StorageBufferAttribute(stack, 1),
      table: words(windows),
      windows: words(windows),
      sources: words(maxChunkCount, 4),
      states: words(2 * maxChunkCount, 4),
      occupied: words(pages + 1),
      matrices: new StorageInstancedBufferAttribute(new Float32Array(this.capacity * 16), 16),
      colors: new StorageInstancedBufferAttribute(new Float32Array(this.capacity * 4), 4),
    };
    this.occupied = this.pool.occupied;
    this.windows = [{ first: 0, count: windows }];
    this.held = Array.from({ length: maxChunkCount }, () => null);
    this.generations = new Uint32Array(maxChunkCount);
    for (let slot = maxChunkCount - 1; slot >= 0; slot--) this.free.push(slot);
  }

  /** Every pool index's instance matrix, as the level meshes draw them. */
  get matrices(): StorageInstancedBufferAttribute {
    return this.pool.matrices;
  }

  /** Every pool index's colour, RGB and a pad. */
  get colors(): StorageInstancedBufferAttribute {
    return this.pool.colors;
  }

  /** Whether the next run takes chunks in or frees them. */
  get pending(): boolean {
    return this.due.size > 0 || this.removed;
  }

  /** Take `chunk` into a free slot at the next run; its slot. */
  add(chunk: PoolChunk): number {
    const slot = this.free.pop();
    if (slot === undefined) throw new Error(`InstancedLod: all ${this.pool.slots} chunk slots are taken: raise LodGpu's maxChunkCount`);
    const windows = Math.ceil(chunk.count / PAGE);
    const base = this.take(windows);
    if (base === null) {
      this.free.push(slot);
      throw new Error(`InstancedLod: chunks span more than the pool's ${this.pool.table.count} windows of ${PAGE} spots: raise LodGpu's maxInstanceCount`);
    }
    this.held[slot] = { chunk, base, windows };
    this.change(slot);
    return slot;
  }

  /** Take slot `slot`'s chunk in again at the next run: its attributes changed. */
  change(slot: number): void {
    const { base, windows, chunk } = this.heldAt(slot);
    const generation = at(this.generations, slot) + 1;
    this.generations[slot] = generation;
    this.write(slot, [base, windows, generation, chunk.row + 1]);
    this.due.add(slot);
  }

  /** Free slot `slot`; its chunk's pages go back to the pool at the next run, its windows after it. */
  remove(slot: number): void {
    const { base, windows } = this.heldAt(slot);
    this.held[slot] = null;
    this.releasing.push({ first: base, count: windows });
    this.write(slot, [0, 0, at(this.generations, slot), 0]);
    this.due.delete(slot);
    this.free.push(slot);
    this.removed = true;
  }

  private heldAt(slot: number): Held {
    const held = this.held[slot];
    if (!held) throw new Error(`InstancedLod: chunk slot ${slot} holds no chunk`);
    return held;
  }

  private write(slot: number, values: readonly number[]): void {
    const { sources } = this.pool;
    sources.array.set(values, slot * 4);
    sources.addUpdateRange(slot * 4, 4);
    sources.needsUpdate = true;
  }

  /** The first of `count` free windows, taken; null if no run of them is free. */
  private take(count: number): number | null {
    if (count === 0) return 0;
    const run = this.windows.find((each) => each.count >= count);
    if (!run) return null;
    const first = run.first;
    run.first += count;
    run.count -= count;
    if (run.count === 0) this.windows.splice(this.windows.indexOf(run), 1);
    return first;
  }

  /** Free the windows of `freed`, merging runs that meet. */
  private giveBack(freed: readonly Run[]): void {
    if (freed.length === 0) return;
    const runs = [...this.windows, ...freed.filter((run) => run.count > 0)].sort((a, b) => a.first - b.first);
    const merged: Run[] = [];
    for (const run of runs) {
      const last = merged.at(-1);
      if (last && last.first + last.count === run.first) last.count += run.count;
      else merged.push({ ...run });
    }
    this.windows = merged;
  }

  /** Take the chunks' changes in on `renderer`, if they changed since the last run. */
  prepare(renderer: Renderer): void {
    if (!this.pending) return;
    const passes = (this.passes ??= new PoolPasses(this.pool));
    // The free pass reads the windows of chunks removed since the last run: they serve chunks taken in after it.
    const freed = this.releasing;
    this.releasing = [];
    renderer.compute(passes.free);
    for (const slot of this.due) this.run(renderer, passes, slot, "count");
    renderer.compute(passes.allocate);
    for (const slot of this.due) this.run(renderer, passes, slot, "write");
    renderer.compute(passes.occupy);
    this.due.clear();
    this.removed = false;
    this.version++;
    this.giveBack(freed);
    if (!this.released) releaseArrays([this.pool.matrices, this.pool.colors]);
    this.released = true;
  }

  /** Run slot `slot`'s chunk's `pass`, one workgroup per window of its range. */
  private run(renderer: Renderer, passes: PoolPasses, slot: number, pass: "count" | "write"): void {
    const { chunk, base, windows } = this.heldAt(slot);
    if (windows === 0) return;
    const { attributes, start, count, countIndex } = chunk;
    renderer.compute(passes.chunkPass(pass, attributes, { slot, base, start, count, countIndex }), [windows, 1, 1]);
  }

  /**
   * The instances the chunks of `slots` hold, once every one has been taken in; null while changes wait for the passes
   * or chunks changed meanwhile. Throws if a chunk lacks pages. Reads the GPU's progress back.
   */
  async status(renderer: Renderer, slots: readonly number[]): Promise<number | null> {
    if (this.pending) return null;
    if (slots.length === 0) return 0;
    const version = this.version;
    const states = await this.statesAt(renderer, version);
    if (version !== this.version || this.pending) return null;
    let instances = 0;
    let short = 0;
    let got = 0;
    let needed = 0;
    for (const slot of slots) {
      const base = slot * 8;
      if (states[base] !== this.generations[slot]) return null;
      instances += at(states, base + 2);
      if (at(states, base + 1) === at(states, base + 3)) continue;
      short++;
      got += at(states, base + 1);
      needed += at(states, base + 3);
    }
    if (short > 0) {
      throw new Error(
        `InstancedLod: ${short} chunk${short === 1 ? "" : "s"} lack pages, holding ${got} of the ${needed} pages they need: raise LodGpu's maxInstanceCount (its pool has ${this.pool.pages} pages of ${PAGE})`,
      );
    }
    return instances;
  }

  /** The chunks' states as the GPU holds them after run `version`: one read back for every InstancedLod asking. */
  private statesAt(renderer: Renderer, version: number): Promise<Uint32Array> {
    if (this.read?.version !== version) {
      const promise = renderer.getArrayBufferAsync(this.pool.states).then((buffer) => new Uint32Array(buffer));
      this.read = { version, promise };
    }
    return this.read.promise;
  }

  dispose(): void {
    const { pool } = this;
    for (const attribute of [pool.stack, pool.table, pool.windows, pool.sources, pool.states, pool.occupied, pool.matrices, pool.colors]) attribute.dispose();
    this.passes?.dispose();
    this.passes = null;
  }
}

/**
 * Drop the CPU arrays of `attributes`, buffers only the GPU writes, once a pass has run with them: they are never read
 * again, and they are most of what they cost on the CPU. This relies on three never uploading them again (as of three
 * r186): nothing marks them for an update, and a LodGpu's renderer, initialised, made each buffer as the pass ran.
 */
export function releaseArrays(attributes: readonly StorageInstancedBufferAttribute[]): void {
  for (const attribute of attributes) attribute.array = new Float32Array(0);
}

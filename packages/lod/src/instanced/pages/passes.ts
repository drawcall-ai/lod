import type { ComputeNode } from "three/webgpu";
import type { PoolBuffers } from "./buffers.js";
import { chunkReads, chunkUniforms, countPass, writePass, type Attributes, type ChunkRange, type ChunkReads } from "./chunk.js";
import { allocatePass, freePass, occupyPass } from "./slots.js";

// The passes that take chunks into a page pool, in the order they run (see index.ts): those over its slots (see
// slots.ts) and those over one chunk (see chunk.ts).

/** The count and write passes for chunks of one layout of attributes, and the nodes they read the chunk by. */
interface ChunkPasses {
  readonly reads: ChunkReads;
  readonly count: ComputeNode;
  readonly write: ComputeNode;
}

/**
 * A pool's passes: built once, the count and write passes once per layout of the attributes they read (colours of a
 * stride or none, counts or none: six at most), and pointed at a chunk's attributes and range as it is about to run
 * (see `chunkPass`). They run at once as the pool prepares, never queued, so no pass still waits to run when the next
 * chunk is set.
 */
export class PoolPasses {
  readonly free: ComputeNode;
  readonly allocate: ComputeNode;
  readonly occupy: ComputeNode;
  private readonly uniforms = chunkUniforms();
  private readonly byLayout = new Map<string, ChunkPasses>();

  constructor(private readonly pool: PoolBuffers) {
    this.free = freePass(pool);
    this.allocate = allocatePass(pool);
    this.occupy = occupyPass(pool);
  }

  /** `pass` for the chunk of `attributes` and `range`, pointed at them: run it before pointing it at another. */
  chunkPass(pass: "count" | "write", attributes: Attributes, range: ChunkRange): ComputeNode {
    const layout = `${attributes.colors?.stride ?? 0}/${attributes.counts ? 1 : 0}`;
    let passes = this.byLayout.get(layout);
    if (!passes) {
      const reads = chunkReads(attributes);
      passes = { reads, count: countPass(this.pool, this.uniforms, reads), write: writePass(this.pool, this.uniforms, reads) };
      this.byLayout.set(layout, passes);
    }
    const { reads } = passes;
    reads.matrices.value = attributes.matrices;
    if (reads.colors && attributes.colors) reads.colors.floats.value = attributes.colors.attribute;
    if (reads.counts && attributes.counts) reads.counts.value = attributes.counts;
    const { uniforms } = this;
    uniforms.slot.value = range.slot;
    uniforms.base.value = range.base;
    uniforms.start.value = range.start;
    uniforms.count.value = range.count;
    uniforms.countIndex.value = range.countIndex;
    return passes[pass];
  }

  dispose(): void {
    const chunkNodes = [...this.byLayout.values()].flatMap(({ count, write }) => [count, write]);
    for (const node of [this.free, this.allocate, this.occupy, ...chunkNodes]) node.dispose();
    this.byLayout.clear();
  }
}

import type { ComputeNode } from "three/webgpu";
import type { InstancedLodInstance } from "../chunk.js";
import type { PoolBuffers } from "./buffers.js";
import { chunkUniforms, countPass, mirrorReader, writePass, type ChunkRange, type ChunkSource, type Mirrors } from "./chunk.js";
import { allocatePass, freePass, occupyPass } from "./slots.js";

// The passes that take chunks into a page pool, in the order they run (see index.ts): those over its slots (see
// slots.ts) and those over one chunk (see chunk.ts).

/** The count and write passes for chunks read by one instance function. */
interface ChunkPasses {
  readonly count: ComputeNode;
  readonly write: ComputeNode;
}

/** A reader of CPU chunks' mirrors, and its passes. */
interface MirrorPasses {
  readonly reader: ReturnType<typeof mirrorReader>;
  readonly passes: ChunkPasses;
}

/**
 * A pool's passes: built once, the count and write passes once per instance function they read chunks by (one per
 * app's function, kept while chunks read by it, see `retain`; and one for CPU chunks with colours and one without),
 * and pointed at a chunk's range, and a CPU chunk's mirrors, as it is about to run (see `chunkPass`). They run at once
 * as the pool prepares, never queued, so no pass still waits to run when the next chunk is set.
 */
export class PoolPasses {
  readonly free: ComputeNode;
  readonly allocate: ComputeNode;
  readonly occupy: ComputeNode;
  private readonly uniforms = chunkUniforms();
  /** The passes reading GPU chunks, by the app's function they read by. */
  private readonly byFunction = new Map<InstancedLodInstance, ChunkPasses>();
  /** The readers of CPU chunks and their passes, by whether the chunks have colours. */
  private readonly byMirrors = new Map<boolean, MirrorPasses>();

  constructor(private readonly pool: PoolBuffers) {
    this.free = freePass(pool);
    this.allocate = allocatePass(pool);
    this.occupy = occupyPass(pool);
  }

  /** `pass` for the chunk of `source` and `range`, pointed at them: run it before pointing it at another. */
  chunkPass(pass: "count" | "write", source: ChunkSource, range: ChunkRange): ComputeNode {
    const passes = typeof source === "function" ? this.ofFunction(source) : this.ofMirrors(source);
    const { uniforms } = this;
    uniforms.slot.value = range.slot;
    uniforms.base.value = range.base;
    uniforms.start.value = range.start;
    uniforms.count.value = range.count;
    return passes[pass];
  }

  /** Dispose the passes of every app's function but those of `used`, the functions chunks still read by. */
  retain(used: ReadonlySet<InstancedLodInstance>): void {
    for (const [instance, passes] of this.byFunction) {
      if (used.has(instance)) continue;
      disposePasses(passes);
      this.byFunction.delete(instance);
    }
  }

  /** The passes reading GPU chunks by `instance`. */
  private ofFunction(instance: InstancedLodInstance): ChunkPasses {
    let passes = this.byFunction.get(instance);
    if (!passes) {
      passes = this.build(instance);
      this.byFunction.set(instance, passes);
    }
    return passes;
  }

  /** The passes reading CPU chunks like `mirrors`, pointed at them. */
  private ofMirrors(mirrors: Mirrors): ChunkPasses {
    const colored = mirrors.colors !== null;
    let found = this.byMirrors.get(colored);
    if (!found) {
      const reader = mirrorReader(mirrors);
      found = { reader, passes: this.build(reader.instance) };
      this.byMirrors.set(colored, found);
    }
    found.reader.point(mirrors);
    return found.passes;
  }

  private build(instance: InstancedLodInstance): ChunkPasses {
    return { count: countPass(this.pool, this.uniforms, instance), write: writePass(this.pool, this.uniforms, instance) };
  }

  dispose(): void {
    for (const node of [this.free, this.allocate, this.occupy]) node.dispose();
    for (const passes of this.byFunction.values()) disposePasses(passes);
    for (const { passes } of this.byMirrors.values()) disposePasses(passes);
    this.byFunction.clear();
    this.byMirrors.clear();
  }
}

function disposePasses({ count, write }: ChunkPasses): void {
  count.dispose();
  write.dispose();
}

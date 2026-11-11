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

/**
 * A pool's passes: built once, the count and write passes once per instance function they read chunks by (one per
 * app's function, and one for CPU chunks with colours and one without), and pointed at a chunk's range, and a CPU
 * chunk's mirrors, as it is about to run (see `chunkPass`). They run at once as the pool prepares, never queued, so no
 * pass still waits to run when the next chunk is set.
 */
export class PoolPasses {
  readonly free: ComputeNode;
  readonly allocate: ComputeNode;
  readonly occupy: ComputeNode;
  private readonly uniforms = chunkUniforms();
  private readonly byInstance = new Map<InstancedLodInstance, ChunkPasses>();
  /** The readers of CPU chunks, by whether they have colours. */
  private readonly mirrorReaders = new Map<boolean, ReturnType<typeof mirrorReader>>();

  constructor(private readonly pool: PoolBuffers) {
    this.free = freePass(pool);
    this.allocate = allocatePass(pool);
    this.occupy = occupyPass(pool);
  }

  /** `pass` for the chunk of `source` and `range`, pointed at them: run it before pointing it at another. */
  chunkPass(pass: "count" | "write", source: ChunkSource, range: ChunkRange): ComputeNode {
    const instance = typeof source === "function" ? source : this.mirrored(source);
    let passes = this.byInstance.get(instance);
    if (!passes) {
      passes = { count: countPass(this.pool, this.uniforms, instance), write: writePass(this.pool, this.uniforms, instance) };
      this.byInstance.set(instance, passes);
    }
    const { uniforms } = this;
    uniforms.slot.value = range.slot;
    uniforms.base.value = range.base;
    uniforms.start.value = range.start;
    uniforms.count.value = range.count;
    return passes[pass];
  }

  /** Dispose the passes reading chunks by `instance`, an app's function no chunk reads by any more. */
  forget(instance: InstancedLodInstance): void {
    const passes = this.byInstance.get(instance);
    if (!passes) return;
    passes.count.dispose();
    passes.write.dispose();
    this.byInstance.delete(instance);
  }

  /** The instance function reading CPU chunks like `mirrors`, pointed at them. */
  private mirrored(mirrors: Mirrors): InstancedLodInstance {
    const colored = mirrors.colors !== null;
    let reader = this.mirrorReaders.get(colored);
    if (!reader) {
      reader = mirrorReader(mirrors);
      this.mirrorReaders.set(colored, reader);
    }
    reader.point(mirrors);
    return reader.instance;
  }

  dispose(): void {
    const chunkNodes = [...this.byInstance.values()].flatMap(({ count, write }) => [count, write]);
    for (const node of [this.free, this.allocate, this.occupy, ...chunkNodes]) node.dispose();
    this.byInstance.clear();
    this.mirrorReaders.clear();
  }
}

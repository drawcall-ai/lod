import type { Renderer } from "three/webgpu";
import { Compiler } from "./levels/compile/index.js";
import { InstancePagePool } from "./instanced/pages/index.js";
import { Sorter } from "./instanced/sort.js";

/** How a LodGpu is sized. */
export interface LodGpuOptions {
  /**
   * The most instances its InstancedLods hold at once, over all their chunks: 65536 by default. Its pool holds 64 bytes
   * of matrix and 16 of colour per instance room. Chunks that together outgrow it are reported (see
   * `InstancedLod.error`), naming it as the limit to raise. The lists each camera holds are
   * sized by every InstancedLod's own `maxInstanceCount` instead (see `InstancedLodOptions`).
   */
  maxInstanceCount?: number;
  /** The most chunks its InstancedLods hold at once: 256 by default. `addChunk` past it throws, naming it. */
  maxChunkCount?: number;
}

const DEFAULT_INSTANCES = 65536;
const DEFAULT_CHUNKS = 256;

/**
 * What every Lod and InstancedLod drawing with one renderer shares, as PMREMGenerator is for environment maps: how
 * their levels compile, the page pool every InstancedLod's instances live in, and the passes that sort them for each
 * camera. Make it once the renderer is initialised (`await renderer.init()`), give it to each Lod and InstancedLod, and
 * dispose it once they are disposed.
 */
export class LodGpu {
  /** The pool every InstancedLod's instances live in. */
  readonly pool: InstancePagePool;
  /** The rows, camera buffers and passes every InstancedLod sorts with. */
  readonly sorter: Sorter;
  /** How levels compile for the renderer. */
  readonly compiler: Compiler;

  constructor(
    readonly renderer: Renderer,
    { maxInstanceCount = DEFAULT_INSTANCES, maxChunkCount = DEFAULT_CHUNKS }: LodGpuOptions = {},
  ) {
    if (!renderer.initialized) throw new Error("LodGpu: initialise the renderer first (await renderer.init())");
    this.pool = new InstancePagePool(maxInstanceCount, maxChunkCount);
    this.sorter = new Sorter(renderer, this.pool);
    this.compiler = new Compiler(renderer);
  }

  /** Whether it was disposed: then no Lod or InstancedLod can be made with it, and its sort takes no camera. */
  get disposed(): boolean {
    return this.sorter.disposed;
  }

  /**
   * Release the pool and the sort's buffers and passes, once every Lod and InstancedLod made with it is disposed. The
   * renderer keeps the wrapper that shares pipelines among level meshes, which costs nothing once they are gone.
   */
  dispose(): void {
    this.sorter.dispose();
    this.pool.dispose();
  }
}

import type { Renderer } from "three/webgpu";
import { InstancePages } from "./instanced/pages/index.js";
import { Sorter } from "./instanced/sort.js";

/** How a LodPool is sized. */
export interface LodPoolOptions {
  /**
   * The most instances its InstancedLods hold at once, over all their chunks: 65536 by default. Its pool holds 64 bytes
   * of matrix and 16 of colour per instance room; the matrices are one storage binding, which the device's
   * `maxStorageBufferBindingSize` bounds. Chunks that together outgrow it are reported (see `InstancedLod.error`),
   * naming it as the limit to raise. The lists each camera holds are sized by every InstancedLod's own
   * `maxInstanceCount` instead (see `InstancedLodOptions`).
   */
  maxInstanceCount?: number;
  /**
   * The most chunks its InstancedLods hold at once: 256 by default. Chunks past it are reported as the render that
   * takes them in draws (see `InstancedLod.error`), naming it.
   */
  maxChunkCount?: number;
}

const DEFAULT_INSTANCES = 65536;
const DEFAULT_CHUNKS = 256;

/**
 * What InstancedLods share: the page pool their instances live in, and the passes that sort them for each camera,
 * every InstancedLod of one pool in one compute call. It needs no renderer: the first that draws one of its
 * InstancedLods draws them all, and three makes its buffers as that render first uses them. Dispose it once its
 * InstancedLods are disposed.
 */
export class LodPool {
  /** The pages every InstancedLod's instances live in. */
  readonly pages: InstancePages;
  /** The rows, camera buffers and passes every InstancedLod sorts with. */
  readonly sorter: Sorter;
  /** What draws its InstancedLods, once one has drawn (see `bind`). */
  private bound: Renderer | null = null;
  private isDisposed = false;

  constructor({ maxInstanceCount = DEFAULT_INSTANCES, maxChunkCount = DEFAULT_CHUNKS }: LodPoolOptions = {}) {
    this.pages = new InstancePages(maxInstanceCount, maxChunkCount);
    this.sorter = new Sorter(this.pages);
  }

  /** Whether it was disposed: then no InstancedLod can be made with it. */
  get disposed(): boolean {
    return this.isDisposed;
  }

  /** `renderer` draws one of its InstancedLods: the first is checked to fit the pool, and no other may. */
  bind(renderer: Renderer): void {
    if (renderer === this.bound) return;
    if (this.bound) throw new Error("InstancedLod: another renderer than the first that drew its LodPool drew it");
    // Each level's draws start at its list (see update.ts).
    if (!renderer.hasFeature("indirect-first-instance"))
      throw new Error("InstancedLod: needs the GPU feature indirect-first-instance, which this device lacks");
    this.pages.checkBinding(maxStorageBinding(renderer));
    this.bound = renderer;
  }

  /**
   * Release the pool and the sort's buffers and passes, once every InstancedLod made with it is disposed: then no
   * InstancedLod can be made with it.
   */
  dispose(): void {
    this.isDisposed = true;
    this.sorter.dispose();
    this.pages.dispose();
  }
}

/** The largest storage binding `renderer`'s device takes: r186's WebGPU backend's `device`, which three's types omit. */
function maxStorageBinding(renderer: Renderer): number {
  const device: unknown = Reflect.get(renderer.backend, "device");
  const limits: unknown = typeof device === "object" && device !== null ? Reflect.get(device, "limits") : null;
  const size: unknown = typeof limits === "object" && limits !== null ? Reflect.get(limits, "maxStorageBufferBindingSize") : null;
  if (typeof size !== "number") throw new Error("InstancedLod: its renderer has no WebGPU device (lod mirrors three r186)");
  return size;
}

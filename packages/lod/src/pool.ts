import type { Renderer } from "three/webgpu";
import { InstancePages, pageCount } from "./instanced/pages/index.js";
import { Sorter } from "./instanced/sort.js";

/** How a LodPool is sized. */
export interface LodPoolOptions {
  /**
   * The most instances its InstancedLods hold at once on one renderer, over all their chunks: 65536 by default. Its
   * pages hold 64 bytes of matrix and 16 of colour per instance room; the matrices are one storage binding, which the
   * device's `maxStorageBufferBindingSize` bounds. Chunks that together outgrow it are reported (see
   * `InstancedLod.error`), naming it as the limit to raise. The lists each camera holds are sized by every
   * InstancedLod's own `maxInstanceCount` instead (see `InstancedLodOptions`).
   */
  maxInstanceCount?: number;
  /** The most chunks its InstancedLods hold at once on one renderer: 256 by default. Past it is reported, naming it. */
  maxChunkCount?: number;
}

const DEFAULT_INSTANCES = 65536;
const DEFAULT_CHUNKS = 256;

/** What a LodPool holds on one renderer: the pages its InstancedLods drawn there keep their instances in, and their sorts. */
export interface PoolOnRenderer {
  readonly pages: InstancePages;
  readonly sorter: Sorter;
}

/**
 * What InstancedLods share: the pages their instances live in, and the passes that sort them for each camera, every
 * InstancedLod of one pool in one compute call. It needs no renderer: each renderer that draws one of its InstancedLods
 * gets pages and sorts of its own, made as it first does. Dispose it once its InstancedLods are disposed.
 */
export class LodPool {
  private readonly maxInstanceCount: number;
  private readonly maxChunkCount: number;
  private readonly renderers = new Map<Renderer, PoolOnRenderer>();
  private isDisposed = false;

  constructor({ maxInstanceCount = DEFAULT_INSTANCES, maxChunkCount = DEFAULT_CHUNKS }: LodPoolOptions = {}) {
    pageCount(maxInstanceCount, maxChunkCount);
    this.maxInstanceCount = maxInstanceCount;
    this.maxChunkCount = maxChunkCount;
  }

  /** Whether it was disposed: then no InstancedLod can be made with it, nor drawn. */
  get disposed(): boolean {
    return this.isDisposed;
  }

  /** What it holds on `renderer`, made the first time: throws if the device cannot draw it. */
  on(renderer: Renderer): PoolOnRenderer {
    if (this.isDisposed) throw new Error("LodPool: disposed");
    const found = this.renderers.get(renderer);
    if (found) return found;
    // Each level's draws start at its list (see update.ts).
    if (!renderer.hasFeature("indirect-first-instance"))
      throw new Error("InstancedLod: needs the GPU feature indirect-first-instance, which this device lacks");
    const pages = new InstancePages(this.maxInstanceCount, this.maxChunkCount, maxStorageBinding(renderer));
    const made = { pages, sorter: new Sorter(pages) };
    this.renderers.set(renderer, made);
    return made;
  }

  /** Release its pages and sorts on every renderer, once every InstancedLod made with it is disposed. */
  dispose(): void {
    this.isDisposed = true;
    for (const { pages, sorter } of this.renderers.values()) {
      sorter.dispose();
      pages.dispose();
    }
    this.renderers.clear();
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

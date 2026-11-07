import type { IndirectStorageBufferAttribute, Renderer, Sphere, StorageBufferAttribute } from "three/webgpu";
import type { Blocks } from "./blocks.js";
import type { Selection } from "./select.js";

/** What an InstancedLod's blocks are made with besides its places' own items (see `Blocks`). */
export interface BlockFrame {
  readonly source: Sphere;
  readonly bounds: Sphere;
  readonly draws: number;
  readonly rest: { readonly radius: number };
  readonly padding: number;
}

/** Pages of places in use, which the selection visits one workgroup each (see kernel.ts) instead of every place. */
export interface Occupied {
  /** The ids of the pages in use, from the first. */
  readonly pages: StorageBufferAttribute;
  /** One workgroup per page in use. */
  readonly dispatch: IndirectStorageBufferAttribute;
}

/** Per place: 16 floats of matrix, one keep ratio, and 4 floats of colour, or no colours for white. */
export interface Seed {
  readonly matrices: Float32Array;
  readonly keeps: Float32Array;
  readonly colors: Float32Array | null;
}

/**
 * Where an InstancedLod's instances live: a fixed number of places, filled from the CPU by chunks of matrices (see
 * store.ts) or on the GPU from records (see pages/index.ts). The selection holds the places' matrices, keep ratios and
 * colours in its buffers, which the places fill.
 */
export interface Places {
  /** Places for instances: what every per-instance buffer holds. */
  readonly capacity: number;
  /** One past the last place in use: the selection visits only the places before it, unless `occupied` says which. */
  readonly end: number;
  readonly occupied: Occupied | null;
  /** What the selection's buffers start from, read once each time they are made. */
  seed(): Seed;
  /** Blocks around the instances, measured; with `survivors`, each instance may draw as much larger as its keep ratio lets it. */
  blocks(frame: BlockFrame, survivors: boolean): Blocks;
  /** Fill `selection`'s buffers from now on; null stops. */
  attach(selection: Selection | null): void;
  /** Measure the instances changed since the last call into `blocks` and send them to the selection. */
  measure(blocks: Blocks): void;
  /** Bring the selection's buffers up to date on `renderer`, before any view selects. */
  prepare(renderer: Renderer): void;
  /** Whether what `prepare` ran has taken every instance in on `renderer`; throws if some never will be. */
  drained(renderer: Renderer): Promise<boolean>;
  dispose(): void;
}

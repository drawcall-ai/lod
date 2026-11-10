import type { StorageBufferAttribute, StorageInstancedBufferAttribute } from "three/webgpu";
import { storage } from "three/tsl";

// The buffers of a page pool, which its passes read and write (see passes.ts).

/** Bits of an occupied page's entry that hold its page; those above hold its InstancedLod's row. */
export const PAGE_BITS = 16;

/** A page pool's sizes and buffers, which its passes read. */
export interface PoolBuffers {
  readonly pages: number;
  readonly slots: number;
  /** The free page count, then the free page ids. */
  readonly stack: StorageBufferAttribute;
  /** Per window of a chunk's range, from its slot's first window (see `sources`): the page it holds. */
  readonly table: StorageBufferAttribute;
  /** Per window of a chunk's range: the window's instances, then where they start among the chunk's. */
  readonly windows: StorageBufferAttribute;
  /**
   * Per slot, written by the CPU: its chunk's first window, its windows, its generation, and its InstancedLod's row
   * plus one (0 while it holds no chunk).
   */
  readonly sources: StorageBufferAttribute;
  /**
   * Per slot, written by the GPU, two vec4s: the generation it got to, its pages, its instances and the pages it needs;
   * then the first window its pages are listed from.
   */
  readonly states: StorageBufferAttribute;
  /** How many pages chunks hold, then per page held its id and its InstancedLod's row (see `PAGE_BITS`). */
  readonly occupied: StorageBufferAttribute;
  /** Every pool index's instance matrix and colour (RGB and a pad), as the level meshes draw them. */
  readonly matrices: StorageInstancedBufferAttribute;
  readonly colors: StorageInstancedBufferAttribute;
}

/** `pool`'s buffers as one pass uses them: a node each, since a pass may not bind a buffer it writes twice. */
export function nodes(pool: PoolBuffers) {
  return {
    stack: storage(pool.stack, "uint", 0).toAtomic(),
    table: storage(pool.table, "uint", 0),
    windows: storage(pool.windows, "uint", 0),
    sources: storage(pool.sources, "uvec4", 0).toReadOnly(),
    states: storage(pool.states, "uvec4", 0),
  };
}

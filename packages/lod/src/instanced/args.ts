import { IndirectStorageBufferAttribute } from "three/webgpu";

/** Bytes per draw, including the unused final word of a non-indexed draw. */
export const ARGS_BYTES = 20;

const PAGE_DRAWS = 4096;
// WebGPU's guaranteed maxStorageBufferBindingSize; a page is one storage binding.
const MAX_BYTES = 128 * 1024 * 1024;

interface Range {
  first: number;
  count: number;
}

interface Page {
  attribute: IndirectStorageBufferAttribute;
  free: Range[];
  users: number;
}

export interface ArgsSlice {
  readonly attribute: IndirectStorageBufferAttribute;
  readonly offset: number;
  dispose(): void;
}

/**
 * Stable slices of fixed-size pages. Sharing the indirect buffer lets WebGPU batch
 * draw validation; growing a page would replace buffers still used by meshes and kernels.
 */
export class Args {
  private readonly pages: Page[] = [];

  constructor(private readonly capacity = PAGE_DRAWS) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity * ARGS_BYTES > MAX_BYTES) {
      throw new Error("InstancedLod: invalid indirect argument page capacity");
    }
  }

  take(values: Uint32Array): ArgsSlice {
    if (values.length % 5 !== 0 || values.byteLength > MAX_BYTES) {
      throw new Error("InstancedLod: indirect arguments exceed a storage binding or contain an incomplete draw");
    }
    const count = Math.max(values.length / 5, 1);
    let page = this.pages.find((page) => page.free.some((range) => range.count >= count));
    if (!page) {
      const capacity = Math.max(this.capacity, count);
      page = { attribute: new IndirectStorageBufferAttribute(new Uint32Array(capacity * 5), 1), free: [{ first: 0, count: capacity }], users: 0 };
      this.pages.push(page);
    }
    const range = page.free.find((range) => range.count >= count);
    if (!range) throw new Error("InstancedLod: no space in indirect argument page");
    const first = range.first;
    range.first += count;
    range.count -= count;
    if (range.count === 0) page.free.splice(page.free.indexOf(range), 1);
    page.users++;
    // Keep a CPU mirror of the fixed fields, but never upload a live page again:
    // its instance counts belong to the GPU. Handover writes all words of each slice.
    page.attribute.array.set(values, first * 5);
    const owned = page;
    let disposed = false;
    return {
      attribute: page.attribute,
      offset: first * ARGS_BYTES,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.release(owned, { first, count });
      },
    };
  }

  private release(page: Page, range: Range): void {
    if (--page.users === 0) {
      this.pages.splice(this.pages.indexOf(page), 1);
      page.attribute.dispose();
      return;
    }
    // Earlier submitted draws finish before a later handover overwrites a reused slice.
    page.free.push(range);
    page.free.sort((a, b) => a.first - b.first);
    const merged: Range[] = [];
    for (const range of page.free) {
      const previous = merged.at(-1);
      if (previous && previous.first + previous.count === range.first) previous.count += range.count;
      else merged.push(range);
    }
    page.free = merged;
  }
}

export const args = new Args();

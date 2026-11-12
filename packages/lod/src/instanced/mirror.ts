import { StorageInstancedBufferAttribute, type InstancedBufferAttribute } from "three/webgpu";

// Storage attributes the GPU reads a Lod's CPU attributes through, uploading what the app marks changed in them, as
// three uploads an InstancedMesh's: binding the app's own attribute through storage() would flag it as a storage
// attribute, which three then pads (an RGB colour to four floats) and treats as one wherever else the app draws it. Each
// takes and clears the source's update ranges, so an InstancedMesh also drawing the source uploads it whole.

/** A CPU instanceMatrix's mirror, over the source's own array. */
export class Mirror {
  readonly attribute: StorageInstancedBufferAttribute;
  /** The source's version it last took in. */
  private version: number;

  constructor(readonly source: InstancedBufferAttribute) {
    this.attribute = new StorageInstancedBufferAttribute(source.array, 16);
    this.version = source.version;
  }

  /** Take in the source's edits: the ranges the app marked changed, all of it without any. Whether it changed. */
  refresh(): boolean {
    const { source, attribute } = this;
    if (source.version === this.version) return false;
    this.version = source.version;
    for (const { start, count } of source.updateRanges) attribute.addUpdateRange(start, count);
    source.clearUpdateRanges();
    attribute.needsUpdate = true;
    return true;
  }

  dispose(): void {
    this.attribute.dispose();
  }
}

/** A CPU instanceColor's mirror: its RGB padded to the four floats a storage colour holds, in an array of its own. */
export class ColorMirror {
  readonly attribute: StorageInstancedBufferAttribute;
  private version: number;

  constructor(readonly source: InstancedBufferAttribute) {
    this.attribute = new StorageInstancedBufferAttribute(new Float32Array(source.count * 4), 4);
    this.copy(0, source.count);
    this.version = source.version;
  }

  /** Take in the source's edits: the instances of the ranges the app marked changed, all without any. Whether it changed. */
  refresh(): boolean {
    const { source, attribute } = this;
    if (source.version === this.version) return false;
    this.version = source.version;
    const ranges = source.updateRanges.length > 0 ? source.updateRanges : [{ start: 0, count: source.array.length }];
    for (const { start, count } of ranges) {
      const first = Math.floor(start / 3);
      const end = Math.min(Math.ceil((start + count) / 3), source.count);
      this.copy(first, end);
      attribute.addUpdateRange(first * 4, (end - first) * 4);
    }
    source.clearUpdateRanges();
    attribute.needsUpdate = true;
    return true;
  }

  dispose(): void {
    this.attribute.dispose();
  }

  /** Copy instances `first` to `end` (exclusive) of the source, white's alpha padding them. */
  private copy(first: number, end: number): void {
    const from = this.source.array;
    const to = this.attribute.array;
    for (let i = first; i < end; i++) {
      to[i * 4] = from[i * 3] ?? 0;
      to[i * 4 + 1] = from[i * 3 + 1] ?? 0;
      to[i * 4 + 2] = from[i * 3 + 2] ?? 0;
      to[i * 4 + 3] = 1;
    }
  }
}

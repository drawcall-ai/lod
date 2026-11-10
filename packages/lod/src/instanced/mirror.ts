import { StorageBufferAttribute, type InstancedBufferAttribute } from "three/webgpu";

/**
 * A storage attribute over a CPU chunk attribute's array, which the page pool reads it through, uploading what the app
 * marks changed in it: binding the app's own attribute through storage() would flag it as a storage attribute, which
 * three then pads (an RGB colour to four floats) and treats as one wherever else the app draws it.
 */
export class Mirror {
  /** A matrix per item, or floats one by one, which three never pads. */
  readonly attribute: StorageBufferAttribute;
  /** The source's version it last took in. */
  private version: number;

  constructor(readonly source: InstancedBufferAttribute) {
    this.attribute = new StorageBufferAttribute(source.array, source.itemSize === 16 ? 16 : 1);
    this.version = source.version;
  }

  /**
   * Take in the source's edits, whose array it shares: upload the ranges the app marked changed (all of it without any),
   * which three would upload and clear were it drawing the source itself. Whether the source changed.
   */
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

import { Box3, Matrix4, Vector3, type InstancedBufferAttribute, type StorageInstancedBufferAttribute } from "three/webgpu";
import { white } from "../levels/fade.js";
import { isStorageInstanced, stretch } from "../three.js";
import { ColorMirror, Mirror } from "./mirror.js";

// What the GPU reads of a Lod's instances: its attributes as storage, read in place or mirrored from the CPU, taken in
// as they are at each update, and what the CPU measures of a CPU instanceMatrix.

/** A Lod's instancing data, as an InstancedMesh holds it. */
export interface InstanceAttributes {
  readonly instanceMatrix: InstancedBufferAttribute;
  readonly instanceColor: InstancedBufferAttribute | null;
  readonly count: number;
}

/** Of a CPU instanceMatrix's first `count` instances at a scale above 0: their origins' box and scales. */
export interface Measured {
  readonly originBox: Box3;
  /** No matrix scales its longest axis less. */
  minScale: number;
  /** No matrix stretches any direction more. */
  maxScale: number;
}

const matrix = new Matrix4();
const origin = new Vector3();

/** A Lod's instances as storage. */
export class Instances {
  /** Bumped whenever what the storage holds, or how many instances there are, may have changed. */
  version = 0;
  /** Measured from a CPU instanceMatrix as it changes; null for a storage one, which the CPU cannot read. */
  measured: Measured | null = null;
  private matrices: { readonly source: InstancedBufferAttribute; readonly mirror: Mirror | null } | null = null;
  private colors: { readonly source: InstancedBufferAttribute; readonly mirror: ColorMirror | null } | null = null;
  private count = -1;

  /** The matrices as the GPU reads them, once taken in. */
  get matrixStorage(): StorageInstancedBufferAttribute {
    const found = this.matrices;
    if (!found) throw new Error("Lod: its instances are read before they were taken in");
    return found.mirror?.attribute ?? storageOf(found.source);
  }

  /** The colours as the GPU reads them, RGB and a pad: white without. */
  get colorStorage(): StorageInstancedBufferAttribute {
    const found = this.colors;
    return found ? (found.mirror?.attribute ?? storageOf(found.source)) : white;
  }

  /**
   * Take in `attributes` as they are: an attribute assigned anew, edits marked by `needsUpdate` (within their update
   * ranges), a new count. A storage instanceMatrix, which the app's GPU passes may write any time, counts as changed
   * at every update. Throws unless they can be drawn.
   */
  refresh({ instanceMatrix, instanceColor, count }: InstanceAttributes): void {
    check(instanceMatrix, instanceColor, count);
    let replaced = false;
    if (this.matrices?.source !== instanceMatrix) {
      this.matrices?.mirror?.dispose();
      this.matrices = { source: instanceMatrix, mirror: isStorageInstanced(instanceMatrix) ? null : new Mirror(instanceMatrix) };
      this.measured = null;
      replaced = true;
    }
    if (this.colors?.source !== (instanceColor ?? undefined)) {
      this.colors?.mirror?.dispose();
      this.colors = instanceColor && { source: instanceColor, mirror: isStorageInstanced(instanceColor) ? null : new ColorMirror(instanceColor) };
      replaced = true;
    }
    const { mirror } = this.matrices;
    const moved = mirror ? mirror.refresh() : true;
    const recoloured = this.colors?.mirror?.refresh() ?? false;
    if (mirror && (moved || replaced || count !== this.count || !this.measured)) this.measured = measure(instanceMatrix, count, this.measured);
    if (replaced || moved || recoloured || count !== this.count) this.version++;
    this.count = count;
  }

  /** Release the mirrors; the attributes are the app's. */
  dispose(): void {
    this.matrices?.mirror?.dispose();
    this.colors?.mirror?.dispose();
    this.matrices = null;
    this.colors = null;
  }
}

/** `attribute`, which `refresh` found a storage attribute. */
function storageOf(attribute: InstancedBufferAttribute): StorageInstancedBufferAttribute {
  if (!isStorageInstanced(attribute)) throw new TypeError("Lod: an attribute read in place is not a storage attribute");
  return attribute;
}

/** Throws unless the attributes hold `count` instances as an InstancedMesh's do; a storage colour pads RGB to four floats. */
function check(instanceMatrix: InstancedBufferAttribute, instanceColor: InstancedBufferAttribute | null, count: number): void {
  if (instanceMatrix.itemSize !== 16 || !(instanceMatrix.array instanceof Float32Array) || instanceMatrix.normalized)
    throw new TypeError(`Lod: instanceMatrix holds 16 floats per instance, not ${instanceMatrix.itemSize}${instanceMatrix.normalized ? " normalized" : ""}`);
  if (!Number.isInteger(count) || count < 0 || count > instanceMatrix.count)
    throw new RangeError(`Lod: count must be an integer from 0 to instanceMatrix.count, ${instanceMatrix.count}, not ${count}`);
  if (!instanceColor) return;
  const size = isStorageInstanced(instanceColor) ? 4 : 3;
  if (instanceColor.itemSize !== size || !(instanceColor.array instanceof Float32Array) || instanceColor.normalized)
    throw new TypeError(`Lod: instanceColor holds ${size} floats per instance${size === 4 ? " in storage" : ""}, not ${instanceColor.itemSize}`);
  if (instanceColor.count < count) throw new RangeError(`Lod: instanceColor holds ${instanceColor.count} instances, fewer than count, ${count}`);
}

/** Measure the first `count` instances of `instanceMatrix` at a scale above 0 into `into`, or a new Measured. */
export function measure(instanceMatrix: InstancedBufferAttribute, count: number, into: Measured | null): Measured {
  const measured = into ?? { originBox: new Box3(), minScale: 0, maxScale: 0 };
  const { array } = instanceMatrix;
  measured.originBox.makeEmpty();
  measured.minScale = Infinity;
  measured.maxScale = 0;
  for (let i = 0; i < count; i++) {
    matrix.fromArray(array, i * 16);
    const scale = matrix.getMaxScaleOnAxis();
    if (scale === 0) continue;
    measured.originBox.expandByPoint(origin.setFromMatrixPosition(matrix));
    measured.minScale = Math.min(measured.minScale, scale);
    measured.maxScale = Math.max(measured.maxScale, stretch(matrix));
  }
  if (measured.originBox.isEmpty()) measured.minScale = measured.maxScale = 0;
  return measured;
}

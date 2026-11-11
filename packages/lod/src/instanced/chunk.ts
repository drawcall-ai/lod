import {
  Box3,
  type Camera,
  type Color,
  type InstancedBufferAttribute,
  Matrix4,
  type StorageBufferAttribute,
  type StorageInstancedBufferAttribute,
  Vector3,
} from "three/webgpu";
import { isStorageInstanced, stretch } from "../three.js";

// A chunk of an InstancedLod's instances: what addChunk takes and returns.

/** The instances of a chunk to add (see `InstancedLod.addChunk`), as an InstancedMesh holds its own. */
export interface InstancedLodChunkParameters {
  /**
   * 16 floats per instance, as InstancedMesh.instanceMatrix holds them. From the CPU, an InstancedBufferAttribute that
   * stays live as an InstancedMesh's does: edit it (see `setMatrixAt`) and set `needsUpdate` (after `addUpdateRange`
   * to upload part of it), and the next render takes the change in. The InstancedLod takes and clears its update
   * ranges, so an InstancedMesh also drawing it uploads it whole. From the GPU, a StorageInstancedBufferAttribute an
   * app's pass writes (such as `instancedArray(n, "mat4")`), read once, in the first render that updates the
   * InstancedLod (see `InstancedLod.update`): the app may reuse it after that render. A matrix of scale 0 is no
   * instance.
   */
  instanceMatrix: InstancedBufferAttribute | StorageInstancedBufferAttribute;
  /**
   * RGB floats per instance, as InstancedMesh.instanceColor holds them, of the same kind as `instanceMatrix`, live or
   * read once as it is, its update ranges taken alike; white without.
   */
  instanceColor?: InstancedBufferAttribute | StorageInstancedBufferAttribute;
  /** The first instance of the attributes to read, and how many: the whole attributes by default, as a drawRange. */
  start?: number;
  count?: number;
  /**
   * From the GPU only: a u32 storage attribute (such as `attributeArray(n, "uint")`) whose item `instanceCountIndex`
   * the app's pass wrote, at most `count`, as drawIndirect's instanceCount: only that many are read. Without it all
   * `count` are.
   */
  instanceCount?: StorageBufferAttribute | StorageInstancedBufferAttribute;
  instanceCountIndex?: number;
  /**
   * From the GPU, required, as the CPU cannot measure the GPU's instances; from the CPU, measured, so not given: a box
   * holding every instance's origin (its matrix's translation) in the InstancedLod's space, and bounds on how much
   * the matrices scale: none shorter than `minScale` along its longest axis, none stretching any direction more than
   * `maxScale`. Which levels load is judged by them.
   */
  originBox?: Box3;
  minScale?: number;
  maxScale?: number;
}

/**
 * What an InstancedLod keeps of one of its chunks, which the chunk shows: its bounds, re-measured as its CPU attributes
 * change, and how it finds the level an instance draws, while the InstancedLod holds it.
 */
export interface ChunkState {
  /** Whether its attributes are the GPU's, told once: binding a CPU attribute through storage() flags it as storage. */
  readonly gpu: boolean;
  readonly originBox: Box3;
  minScale: number;
  maxScale: number;
  readonly boundingBox: Box3;
  levelAt: ((index: number, camera: Camera) => number | null) | null;
}

const matrix = new Matrix4();
const origin = new Vector3();

/**
 * Instances added to an InstancedLod in one call and removed whole (see `InstancedLod.addChunk`). An instance's index
 * is its index in the chunk's range of its attributes, stable while other chunks come and go. The methods reading or
 * writing instances work for a chunk from the CPU only: a GPU chunk's instances live on the GPU, and its methods throw.
 */
export class InstancedLodChunk {
  readonly instanceMatrix: InstancedBufferAttribute | StorageInstancedBufferAttribute;
  readonly instanceColor: InstancedBufferAttribute | StorageInstancedBufferAttribute | null;
  readonly start: number;
  readonly count: number;
  readonly instanceCount: StorageBufferAttribute | StorageInstancedBufferAttribute | null;
  readonly instanceCountIndex: number;

  /** Made by `InstancedLod.addChunk`. */
  constructor(
    parameters: InstancedLodChunkParameters,
    private readonly state: ChunkState,
  ) {
    const { instanceMatrix, instanceColor = null, instanceCount = null, instanceCountIndex = 0 } = parameters;
    const { gpu } = state;
    if (isStorageInstanced(instanceMatrix) !== gpu) throw new Error("InstancedLod: a chunk's state is of another kind than its instanceMatrix");
    const { start = 0, count = instanceMatrix.count - start } = parameters;
    if (instanceMatrix.itemSize !== 16)
      throw new TypeError(`InstancedLod: a chunk's instanceMatrix holds 16 floats per instance, not ${instanceMatrix.itemSize}`);
    if (!(instanceMatrix.array instanceof Float32Array) || instanceMatrix.normalized)
      throw new TypeError("InstancedLod: a chunk's instanceMatrix holds floats, not normalized");
    if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > instanceMatrix.count)
      throw new RangeError(`InstancedLod: a chunk's range of ${count} from ${start} passes the ${instanceMatrix.count} instances of its instanceMatrix`);
    if (instanceColor) {
      if (isStorageInstanced(instanceColor) !== gpu) throw new TypeError("InstancedLod: a chunk's instanceColor is of another kind than its instanceMatrix");
      // A storage attribute's vec3 is padded to four floats once on the GPU.
      if (instanceColor.itemSize !== 3 && !(gpu && instanceColor.itemSize === 4))
        throw new TypeError(`InstancedLod: a chunk's instanceColor holds RGB per instance, not ${instanceColor.itemSize} floats`);
      if (!(instanceColor.array instanceof Float32Array) || instanceColor.normalized)
        throw new TypeError("InstancedLod: a chunk's instanceColor holds floats, not normalized");
      if (instanceColor.count < start + count) throw new RangeError("InstancedLod: a chunk's instanceColor holds fewer instances than its range");
    }
    if (instanceCount) {
      if (!gpu) throw new TypeError("InstancedLod: only a GPU chunk takes an instanceCount");
      if (!(instanceCount.array instanceof Uint32Array) || instanceCount.itemSize !== 1)
        throw new TypeError("InstancedLod: a chunk's instanceCount holds u32 items");
      if (!Number.isInteger(instanceCountIndex) || instanceCountIndex < 0 || instanceCountIndex >= instanceCount.count)
        throw new RangeError(`InstancedLod: a chunk's instanceCountIndex ${instanceCountIndex} passes the end of its instanceCount`);
    }
    const { originBox, minScale, maxScale } = parameters;
    const given = originBox !== undefined || minScale !== undefined || maxScale !== undefined;
    if (gpu && (!originBox || minScale === undefined || maxScale === undefined))
      throw new TypeError("InstancedLod: a GPU chunk needs its originBox, minScale and maxScale: the CPU cannot measure the GPU's instances");
    if (!gpu && given) throw new TypeError("InstancedLod: a CPU chunk's originBox, minScale and maxScale are measured from its instances, not given");
    if (originBox && minScale !== undefined && maxScale !== undefined) {
      if (!(minScale > 0 && minScale <= maxScale && Number.isFinite(maxScale)))
        throw new RangeError(`InstancedLod: a chunk's scales must be 0 < minScale <= maxScale, got ${minScale}, ${maxScale}`);
      if (originBox.isEmpty() || ![...originBox.min.toArray(), ...originBox.max.toArray()].every(Number.isFinite))
        throw new RangeError("InstancedLod: a chunk's originBox must be finite and not empty");
      state.originBox.copy(originBox);
      state.minScale = minScale;
      state.maxScale = maxScale;
    }
    this.instanceMatrix = instanceMatrix;
    this.instanceColor = instanceColor;
    this.start = start;
    this.count = count;
    this.instanceCount = instanceCount;
    this.instanceCountIndex = instanceCountIndex;
    if (!gpu) measureChunk(this, state);
  }

  /** Holds every instance's origin, in the InstancedLod's space: given for a GPU chunk, measured for a CPU one. */
  get originBox(): Box3 {
    return this.state.originBox;
  }

  /** No matrix scales its longest axis less: given for a GPU chunk, measured for a CPU one. */
  get minScale(): number {
    return this.state.minScale;
  }

  /** No matrix stretches any direction more: given for a GPU chunk, measured for a CPU one. */
  get maxScale(): number {
    return this.state.maxScale;
  }

  /**
   * Bounds every instance's every level, swaying included, in the InstancedLod's space: the box of its origins grown
   * by the largest level.
   */
  get boundingBox(): Box3 {
    return this.state.boundingBox;
  }

  /** Write instance `index`'s matrix into `instanceMatrix`; set its `needsUpdate` to draw it. */
  setMatrixAt(index: number, value: Matrix4): void {
    value.toArray(this.cpu(index).instanceMatrix.array, (this.start + index) * 16);
  }

  getMatrixAt(index: number, target: Matrix4): Matrix4 {
    return target.fromArray(this.cpu(index).instanceMatrix.array, (this.start + index) * 16);
  }

  /** Write instance `index`'s colour into `instanceColor`; set its `needsUpdate` to draw it. */
  setColorAt(index: number, color: Color): void {
    color.toArray(this.colors(index).array, (this.start + index) * 3);
  }

  /** Instance `index`'s colour: white without `instanceColor`. */
  getColorAt(index: number, color: Color): Color {
    const { instanceColor } = this.cpu(index);
    return instanceColor ? color.fromArray(instanceColor.array, (this.start + index) * 3) : color.setRGB(1, 1, 1);
  }

  /**
   * The level that draws most of instance `index`'s pixels for `camera` from where it is now, with the levels loaded
   * now and no arrival under way, as Lod.getLevel tells; null at scale 0, thinned out by `cullDistance`, or while no
   * level it could draw is loaded. From the attributes as they are, edits not yet drawn included. It throws for every
   * instance while `cullDistance` or the thresholds are invalid, and before a render has updated its InstancedLod.
   */
  getLevelAt(index: number, camera: Camera): number | null {
    const { levelAt } = this.state;
    if (!levelAt) throw new Error("InstancedLod: the chunk was removed from its InstancedLod");
    this.cpu(index);
    return levelAt(index, camera);
  }

  /** This chunk, whose instances the CPU holds, after checking `index` is one of them. */
  private cpu(index: number): this {
    if (this.state.gpu) throw new Error("InstancedLod: a GPU chunk's instances live on the GPU: the CPU cannot read or write them");
    if (!Number.isInteger(index) || index < 0 || index >= this.count)
      throw new RangeError(`InstancedLod: ${index} is not an instance of the chunk's ${this.count}`);
    return this;
  }

  private colors(index: number): InstancedBufferAttribute {
    const { instanceColor } = this.cpu(index);
    if (!instanceColor) throw new Error("InstancedLod: give the chunk an instanceColor to colour its instances");
    return instanceColor;
  }
}

/** Measure into `state` the origins and scales of `chunk`'s instances at a scale above 0, from its CPU attributes. */
export function measureChunk(chunk: InstancedLodChunk, state: ChunkState): void {
  const { array } = chunk.instanceMatrix;
  state.originBox.makeEmpty();
  state.minScale = Infinity;
  state.maxScale = 0;
  for (let i = chunk.start; i < chunk.start + chunk.count; i++) {
    matrix.fromArray(array, i * 16);
    const scale = matrix.getMaxScaleOnAxis();
    if (scale === 0) continue;
    state.originBox.expandByPoint(origin.setFromMatrixPosition(matrix));
    state.minScale = Math.min(state.minScale, scale);
    state.maxScale = Math.max(state.maxScale, stretch(matrix));
  }
  if (state.originBox.isEmpty()) state.minScale = state.maxScale = 0;
}

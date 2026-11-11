import { type Box3, type Camera, type Color, type InstancedBufferAttribute, Matrix4, type Node, Vector3 } from "three/webgpu";
import { isStorageInstanced, stretch } from "../three.js";

// A chunk of an InstancedLod's instances: what addChunk takes and returns.

/**
 * How a GPU chunk reads its instances from the app's own records, in TSL: the nodes of record `index`'s matrix, at
 * scale 0 for no instance, and its colour, white without. The pass copying chunks into lod's pages is built once per
 * function: give chunks of the same records one function, and each its own `start`.
 */
export type InstancedLodInstance = (index: Node<"uint">) => { matrix: Node<"mat4">; color?: Node<"vec3"> };

/** The instances of a chunk to add (see `InstancedLod.addChunk`): from the CPU or from the GPU. */
export type InstancedLodChunkParameters = InstancedLodCpuChunkParameters | InstancedLodGpuChunkParameters;

/** A chunk's instances from the CPU, as an InstancedMesh holds its own. */
export interface InstancedLodCpuChunkParameters {
  /**
   * 16 floats per instance, as InstancedMesh.instanceMatrix holds them, live as an InstancedMesh's are: edit it (see
   * `setMatrixAt`) and set `needsUpdate` (after `addUpdateRange` to upload part of it), and the next render takes the
   * change in. The InstancedLod takes and clears its update ranges, so an InstancedMesh also drawing it uploads it
   * whole. A matrix of scale 0 is no instance.
   */
  instanceMatrix: InstancedBufferAttribute;
  /** RGB floats per instance, as InstancedMesh.instanceColor holds them, live as `instanceMatrix` is; white without. */
  instanceColor?: InstancedBufferAttribute;
  /** The first instance of the attributes to read, and how many: the whole attributes by default, as a drawRange. */
  start?: number;
  count?: number;
  instance?: never;
  originBox?: never;
  minScale?: never;
  maxScale?: never;
}

/**
 * A chunk's instances from the GPU: the records from `start` (0 by default) to `start + count`, as `instance` reads
 * them, read once, in the first render that updates the InstancedLod (see `InstancedLod.update`): the app may reuse
 * them after that render.
 */
export interface InstancedLodGpuChunkParameters {
  instance: InstancedLodInstance;
  start?: number;
  count: number;
  /**
   * What the CPU cannot measure of the GPU's instances: a box holding every instance's origin (its matrix's
   * translation) in the InstancedLod's space, and bounds on how much the matrices scale: none shorter than `minScale`
   * along its longest axis, none stretching any direction more than `maxScale`. Which levels load is judged by them.
   */
  originBox: Box3;
  minScale: number;
  maxScale: number;
  instanceMatrix?: never;
  instanceColor?: never;
}

/**
 * What an InstancedLod keeps of one of its chunks, which the chunk shows: its bounds, re-measured as its CPU attributes
 * change, and whether the InstancedLod still holds it.
 */
export interface ChunkState {
  readonly originBox: Box3;
  minScale: number;
  maxScale: number;
  readonly boundingBox: Box3;
  held: boolean;
}

/** The level instance `index` of `chunk` draws for `camera` (see `InstancedLodCpuChunk.getLevelAt`). */
export type LevelAt = (chunk: InstancedLodCpuChunk, index: number, camera: Camera) => number | null;

const matrix = new Matrix4();
const origin = new Vector3();

/**
 * Instances added to an InstancedLod in one call and removed whole (see `InstancedLod.addChunk`): an
 * InstancedLodCpuChunk or an InstancedLodGpuChunk. An instance's index is its index in the chunk's range, stable while
 * other chunks come and go.
 */
export abstract class InstancedLodChunk {
  protected constructor(
    readonly start: number,
    readonly count: number,
    protected readonly state: ChunkState,
  ) {}

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
}

/** A chunk whose instances the CPU holds, in its attributes: what `InstancedLod.addChunk` makes of CPU parameters. */
export class InstancedLodCpuChunk extends InstancedLodChunk {
  readonly instanceMatrix: InstancedBufferAttribute;
  readonly instanceColor: InstancedBufferAttribute | null;

  /** Made by `InstancedLod.addChunk`. */
  constructor(
    parameters: InstancedLodCpuChunkParameters,
    state: ChunkState,
    private readonly levelAt: LevelAt,
  ) {
    const { instanceMatrix, instanceColor = null, start = 0, count = instanceMatrix.count - start } = parameters;
    if (isStorageInstanced(instanceMatrix) || parameters.originBox !== undefined || parameters.minScale !== undefined || parameters.maxScale !== undefined)
      throw new TypeError(
        "InstancedLod: a chunk with an instanceMatrix is read on the CPU, which measures its originBox, minScale and maxScale: for instances on the GPU, give an `instance` function instead",
      );
    if (instanceMatrix.itemSize !== 16)
      throw new TypeError(`InstancedLod: a chunk's instanceMatrix holds 16 floats per instance, not ${instanceMatrix.itemSize}`);
    if (!(instanceMatrix.array instanceof Float32Array) || instanceMatrix.normalized)
      throw new TypeError("InstancedLod: a chunk's instanceMatrix holds floats, not normalized");
    checkRange(start, count);
    if (start + count > instanceMatrix.count)
      throw new RangeError(`InstancedLod: a chunk's range of ${count} from ${start} passes the ${instanceMatrix.count} instances of its instanceMatrix`);
    if (instanceColor) {
      if (instanceColor.itemSize !== 3)
        throw new TypeError(`InstancedLod: a chunk's instanceColor holds RGB per instance, not ${instanceColor.itemSize} floats`);
      if (!(instanceColor.array instanceof Float32Array) || instanceColor.normalized)
        throw new TypeError("InstancedLod: a chunk's instanceColor holds floats, not normalized");
      if (instanceColor.count < start + count) throw new RangeError("InstancedLod: a chunk's instanceColor holds fewer instances than its range");
    }
    super(start, count, state);
    this.instanceMatrix = instanceMatrix;
    this.instanceColor = instanceColor;
    measureChunk(this, state);
  }

  /** Write instance `index`'s matrix into `instanceMatrix`; set its `needsUpdate` to draw it. */
  setMatrixAt(index: number, value: Matrix4): void {
    value.toArray(this.instanceMatrix.array, this.item(index) * 16);
  }

  getMatrixAt(index: number, target: Matrix4): Matrix4 {
    return target.fromArray(this.instanceMatrix.array, this.item(index) * 16);
  }

  /** Write instance `index`'s colour into `instanceColor`; set its `needsUpdate` to draw it. */
  setColorAt(index: number, color: Color): void {
    const item = this.item(index);
    if (!this.instanceColor) throw new Error("InstancedLod: give the chunk an instanceColor to colour its instances");
    color.toArray(this.instanceColor.array, item * 3);
  }

  /** Instance `index`'s colour: white without `instanceColor`. */
  getColorAt(index: number, color: Color): Color {
    const item = this.item(index);
    return this.instanceColor ? color.fromArray(this.instanceColor.array, item * 3) : color.setRGB(1, 1, 1);
  }

  /**
   * The level that draws most of instance `index`'s pixels for `camera` from where it is now, with the levels loaded
   * now and no arrival under way, as Lod.getLevel tells; null at scale 0, thinned out by `cullDistance`, or while no
   * level it could draw is loaded. From the attributes as they are, edits not yet drawn included. It throws for every
   * instance while `cullDistance` or the thresholds are invalid.
   */
  getLevelAt(index: number, camera: Camera): number | null {
    if (!this.state.held) throw new Error("InstancedLod: the chunk was removed from its InstancedLod");
    this.item(index);
    return this.levelAt(this, index, camera);
  }

  /** The item of the attributes holding instance `index`, after checking it is one of the chunk's. */
  private item(index: number): number {
    if (!(Number.isInteger(index) && index >= 0 && index < this.count))
      throw new RangeError(`InstancedLod: ${index} is not an instance of the chunk's ${this.count}`);
    return this.start + index;
  }
}

/**
 * A chunk whose instances the app's records on the GPU hold, which the CPU cannot read or write: what
 * `InstancedLod.addChunk` makes of GPU parameters.
 */
export class InstancedLodGpuChunk extends InstancedLodChunk {
  readonly instance: InstancedLodInstance;

  /** Made by `InstancedLod.addChunk`. */
  constructor(parameters: InstancedLodGpuChunkParameters, state: ChunkState) {
    if (parameters.instanceMatrix !== undefined || parameters.instanceColor !== undefined)
      throw new TypeError("InstancedLod: a GPU chunk reads its instances by its instance function: give it no instanceMatrix or instanceColor");
    const { instance, start = 0, count, originBox, minScale, maxScale } = parameters;
    checkRange(start, count);
    if (!(minScale > 0 && minScale <= maxScale && Number.isFinite(maxScale)))
      throw new RangeError(`InstancedLod: a chunk's scales must be 0 < minScale <= maxScale, got ${minScale}, ${maxScale}`);
    if (originBox.isEmpty() || ![...originBox.min.toArray(), ...originBox.max.toArray()].every(Number.isFinite))
      throw new RangeError("InstancedLod: a chunk's originBox must be finite and not empty");
    super(start, count, state);
    state.originBox.copy(originBox);
    state.minScale = minScale;
    state.maxScale = maxScale;
    this.instance = instance;
  }
}

function checkRange(start: number, count: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0)
    throw new RangeError(`InstancedLod: a chunk's start and count must be integers of at least 0, got ${start}, ${count}`);
}

/** Measure into `state` the origins and scales of `chunk`'s instances at a scale above 0, from its CPU attributes. */
export function measureChunk(chunk: InstancedLodCpuChunk, state: ChunkState): void {
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

import { type ComputeNode, Matrix4, type Node, type StorageBufferAttribute } from "three/webgpu";
import { If, localId, mat4, storage, uniform, vec3, vec4, workgroupId } from "three/tsl";
import { maxScale } from "../../tsl.js";
import type { InstancedLodInstance } from "../chunk.js";
import { nodes, type PoolBuffers } from "./buffers.js";
import { PAGE, rank, workgroups } from "./workgroup.js";

// The passes that read one chunk's instances, one workgroup per window of its range: counting its instances, and
// writing them into the pages they got (see index.ts for the order they run in).

/** The matrix of a pool index without an instance: scale 0 draws nothing. */
const nothing = new Matrix4().multiplyScalar(0);

/** A CPU chunk's attributes as the pool reads them: its matrices, and its colours or none (white), floats one by one. */
export interface Mirrors {
  readonly matrices: StorageBufferAttribute;
  readonly colors: StorageBufferAttribute | null;
}

/** What a chunk's instances are read from: a GPU chunk's records, as the app reads them, or a CPU chunk's mirrors. */
export type ChunkSource = InstancedLodInstance | Mirrors;

/** A chunk the count and write passes read: its slot, its first window, and its range of its source. */
export interface ChunkRange {
  readonly slot: number;
  readonly base: number;
  readonly start: number;
  readonly count: number;
}

/** The chunk the count and write passes read next, set before each runs. */
export function chunkUniforms() {
  return {
    slot: uniform(0, "uint"),
    base: uniform(0, "uint"),
    start: uniform(0, "uint"),
    count: uniform(0, "uint"),
  };
}

export type ChunkUniforms = ReturnType<typeof chunkUniforms>;

/**
 * How the passes read CPU chunks with mirrors like `first`: through nodes pointed at each chunk's own mirrors (see
 * `point`) before its passes run.
 */
export function mirrorReader(first: Mirrors) {
  const matrices = storage(first.matrices, "mat4", 0).toReadOnly();
  const colors = first.colors && storage(first.colors, "float", 0).toReadOnly();
  const instance: InstancedLodInstance = (index) => {
    const matrix = matrices.element(index);
    if (!colors) return { matrix };
    const red = index.mul(3);
    return { matrix, color: vec3(colors.element(red), colors.element(red.add(1)), colors.element(red.add(2))) };
  };
  const point = (mirrors: Mirrors) => {
    matrices.value = mirrors.matrices;
    if (colors && mirrors.colors) colors.value = mirrors.colors;
  };
  return { instance, point };
}

/**
 * This lane's instance of `chunk`, read by `instance`: its matrix (scale 0 past the chunk's range), its colour if
 * `withColor` (white otherwise, its nodes left out of the pass), and whether it is an instance, at a scale above 0.
 */
function read(chunk: ChunkUniforms, instance: InstancedLodInstance, withColor: boolean) {
  const index = workgroupId.x.mul(PAGE).add(localId.x).toVar();
  const matrix = mat4(nothing).toVar();
  const color = vec3(1).toVar();
  If(index.lessThan(chunk.count), () => {
    const read = instance(chunk.start.add(index));
    matrix.assign(read.matrix);
    if (withColor && read.color) color.assign(read.color);
  });
  return { matrix, color, live: maxScale(matrix).greaterThan(0) };
}

/** Counts each window's instances of `chunk`, read by `instance`: one workgroup per window. */
export function countPass(pool: PoolBuffers, chunk: ChunkUniforms, instance: InstancedLodInstance): ComputeNode {
  const { windows } = nodes(pool);
  return workgroups(() => {
    const { live } = read(chunk, instance, false);
    const { total } = rank(live);
    If(localId.x.equal(0), () => void windows.element(chunk.base.add(workgroupId.x)).assign(total));
  });
}

/**
 * Writes each window's instances of `chunk`, read by `instance`, into its pages, in order, and clears the room past its
 * last instance on its last page, which then draw nothing: one workgroup per window.
 */
export function writePass(pool: PoolBuffers, chunk: ChunkUniforms, instance: InstancedLodInstance): ComputeNode {
  const { windows, table, states } = nodes(pool);
  const matrices = storage(pool.matrices, "mat4", 0);
  const colors = storage(pool.colors, "vec4", 0);
  return workgroups(() => {
    /** The pool index of the chunk's instance `packed`, its index among the chunk's instances. */
    const poolIndexOf = (packed: Node<"uint">) =>
      table
        .element(chunk.base.add(packed.div(PAGE)))
        .mul(PAGE)
        .add(packed.mod(PAGE))
        .toVar();
    const state = states.element(chunk.slot.mul(2)).toVar();
    const { matrix, color, live } = read(chunk, instance, true);
    const { before } = rank(live);
    const packed = windows.element(chunk.base.add(workgroupId.x)).add(before).toVar();
    // Instances past the pages the chunk got are left out.
    If(live.and(packed.lessThan(state.y.mul(PAGE))), () => {
      const into = poolIndexOf(packed);
      matrices.element(into).assign(matrix);
      colors.element(into).assign(vec4(color, 1));
    });
    If(workgroupId.x.equal(0), () => {
      const tail = state.z.add(localId.x).toVar();
      If(tail.lessThan(state.y.mul(PAGE)), () => void matrices.element(poolIndexOf(tail)).assign(mat4(nothing)));
    });
  });
}

import { type ComputeNode, Matrix4, type Node, type StorageBufferAttribute, type StorageInstancedBufferAttribute } from "three/webgpu";
import { If, localId, mat4, storage, uniform, vec3, vec4, workgroupId } from "three/tsl";
import { maxScale } from "../../tsl.js";
import { nodes, type PoolBuffers } from "./buffers.js";
import { PAGE, least, rank, workgroups } from "./workgroup.js";

// The passes that read one chunk's attributes, one workgroup per window of its range: counting its instances, and
// writing them into the pages they got (see index.ts for the order they run in).

/** The matrix of a pool index without an instance: scale 0 draws nothing. */
const nothing = new Matrix4().multiplyScalar(0);

/**
 * The attributes chunks are read from: matrices, colours or none (white) with the floats between instances' colours,
 * and an instance count's buffer or none.
 */
export interface Attributes {
  readonly matrices: Storage;
  readonly colors: { readonly attribute: Storage; readonly stride: 3 | 4 } | null;
  readonly counts: Storage | null;
}

/** A storage attribute, of either kind. */
type Storage = StorageBufferAttribute | StorageInstancedBufferAttribute;

/** A chunk the count and write passes read: its slot, its first window, its range of its attributes, and where its instance count lies. */
export interface ChunkRange {
  readonly slot: number;
  readonly base: number;
  readonly start: number;
  readonly count: number;
  readonly countIndex: number;
}

/** The chunk the count and write passes read next, set before each runs. */
export function chunkUniforms() {
  return {
    slot: uniform(0, "uint"),
    base: uniform(0, "uint"),
    start: uniform(0, "uint"),
    count: uniform(0, "uint"),
    countIndex: uniform(0, "uint"),
  };
}

export type ChunkUniforms = ReturnType<typeof chunkUniforms>;

/** Nodes reading a chunk's attributes, for their layout; pointed at each chunk's own before its passes run. */
export function chunkReads({ matrices, colors, counts }: Attributes) {
  return {
    matrices: storage(matrices, "mat4", 0).toReadOnly(),
    colors: colors && { floats: storage(colors.attribute, "float", 0).toReadOnly(), stride: colors.stride },
    counts: counts && storage(counts, "uint", 0).toReadOnly(),
  };
}

export type ChunkReads = ReturnType<typeof chunkReads>;

/**
 * This lane's instance of `chunk`, read by `reads`: the lane's index in the chunk's range, its matrix (scale 0 past the
 * chunk's instance count) and colour, and whether it is an instance, at a scale above 0.
 */
function read(chunk: ChunkUniforms, { matrices, colors, counts }: ChunkReads) {
  const index = workgroupId.x.mul(PAGE).add(localId.x).toVar();
  const total = counts ? least(counts.element(chunk.countIndex), chunk.count) : chunk.count;
  const m = mat4(nothing).toVar();
  If(index.lessThan(total), () => void m.assign(matrices.element(chunk.start.add(index))));
  const first = chunk.start.add(index).mul(colors?.stride ?? 3);
  const color = colors ? vec3(colors.floats.element(first), colors.floats.element(first.add(1)), colors.floats.element(first.add(2))) : vec3(1);
  return { index, matrix: m, color, live: maxScale(m).greaterThan(0) };
}

/** Counts each window's instances of `chunk`, read by `reads`: one workgroup per window. */
export function countPass(pool: PoolBuffers, chunk: ChunkUniforms, reads: ChunkReads): ComputeNode {
  const { windows } = nodes(pool);
  return workgroups(() => {
    const { live } = read(chunk, reads);
    const { total } = rank(live);
    If(localId.x.equal(0), () => void windows.element(chunk.base.add(workgroupId.x)).assign(total));
  });
}

/**
 * Writes each window's instances of `chunk`, read by `reads`, into its pages, in order, and clears the room past its
 * last instance on its last page, which then draw nothing: one workgroup per window.
 */
export function writePass(pool: PoolBuffers, chunk: ChunkUniforms, reads: ChunkReads): ComputeNode {
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
    const { matrix, color, live } = read(chunk, reads);
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

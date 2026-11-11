import type { IndirectStorageBufferAttribute, Node, StorageBufferAttribute, StorageInstancedBufferAttribute } from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  Return,
  atomicAdd,
  atomicLoad,
  atomicStore,
  computeKernel,
  distance,
  dot,
  float,
  globalId,
  int,
  localId,
  mat4,
  storage,
  uint,
  uniform,
  vec4,
  workgroupId,
} from "three/tsl";
import { levelsToDrawNode } from "../levels/draw.js";
import { column, maxScale, stretch } from "../tsl.js";
import { toTsl } from "../typegpu.js";
import { PAGE_BITS } from "./pages/buffers.js";
import { cullScale, instanceOnScreen } from "./measure.js";
import { PAGE } from "./pages/workgroup.js";
import { COUNTS_PER_ROW, DRAW_BYTES, FLOATS_AT, FLOAT_ROW, INTS_AT, INT_ROW, UNLISTED } from "./rows.js";

// Sorting every InstancedLod's instances into its levels' instance lists for one camera, on the GPU, in two passes a
// LodPool builds once (see sort.ts).
//
// One workgroup per page of the pool (see pages/index.ts), one lane per pool index of the pages in use: updateInstance
// reads the row of the page's InstancedLod, which holds all it sorts by for the camera, and skips the page unless the
// row is sorting. It skips an index at scale 0, thins the instance out by `cullDistance`, skips it outside the camera's
// frustum, measures its height on screen from its matrix with instanceOnScreen, picks what it draws with levelsToDraw,
// the function a Lod runs on the CPU, and appends itself to each level it draws: its pool index and signed fade go to
// that level's next free slot. Each level of an InstancedLod that draws something has a list of its `listSize` slots,
// from the start its row gives; the level's draws start there (their first instance). The indirect pass, one lane per row, hands each level's
// count to the indirect draws of the row's meshes and clears its counts for the next camera. Both stay within WebGPU's
// default limit of 8 storage buffers per stage.

const cullScaleNode = toTsl("lodCullScale", ["origin", "distance", "near", "far", "survivors"], cullScale);
const instanceOnScreenNode = toTsl("lodInstanceOnScreen", ["matrix", "source", "grow", "eye", "scale", "ortho"], instanceOnScreen);

/** The buffers the sort passes read and write: pointed at a camera's (rows, lists, args) as it sorts. */
export interface SortBuffers {
  /** Every row, for the camera: its u32s and its f32s (see rows.ts). */
  words: StorageBufferAttribute;
  floats: StorageBufferAttribute;
  /** The pool's matrices, and survivors' scaled ones, which the level meshes draw while survivors scale. */
  matrices: StorageInstancedBufferAttribute;
  scaled: StorageInstancedBufferAttribute;
  /** The camera's slots: per slot, the pool index it draws and its signed fade. */
  indices: StorageBufferAttribute;
  fades: StorageBufferAttribute;
  /** Per row and level, how many instances it holds for the camera: counted by updateInstance, cleared by the indirect pass. */
  counts: StorageBufferAttribute;
  /** How many pages chunks hold, then each with its row (see pages/buffers.ts). */
  occupied: StorageBufferAttribute;
  /** Every row's draws, from its first (see `drawWords` in rows.ts). */
  draws: StorageBufferAttribute;
  /** The camera's indirect draws, five words each, in the order of `draws`. */
  args: IndirectStorageBufferAttribute;
}

/** The sort passes over `buffers`, their nodes pointed at other buffers by `point`, for a pool of `pages` pages. */
export function sortPasses(buffers: SortBuffers, pages: number) {
  if (pages > MAX_WORKGROUPS)
    throw new RangeError(`LodPool: a pool of ${pages} pages outgrows one dispatch of ${MAX_WORKGROUPS} workgroups: lower maxInstanceCount or maxChunkCount`);
  const nodes = nodesOf(buffers);
  const rowCount = uniform(0, "uint");
  const update = computeKernel(
    Fn(() => {
      If(workgroupId.x.greaterThanEqual(nodes.occupied.element(0)), () => void Return());
      const entry = nodes.occupied.element(workgroupId.x.add(1)).toVar();
      const row = entry.shiftRight(PAGE_BITS).toVar();
      const page = entry.bitAnd(2 ** PAGE_BITS - 1);
      updateInstance(nodes, row, page.mul(PAGE).add(localId.x).toVar());
    })(),
    [PAGE],
  );
  update.dispatchSize = [pages, 1, 1];
  const indirect = computeKernel(
    Fn(() => {
      const row = globalId.x.toVar();
      If(row.greaterThanEqual(rowCount), () => void Return());
      writeDraws(nodes, row);
    })(),
    [LANES],
  );
  return {
    update,
    indirect,
    /** Point the passes at `buffers`, and dispatch the indirect pass over `rows` rows: before they run. */
    point(next: SortBuffers, rows: number): void {
      nodes.words.value = next.words;
      nodes.floats.value = next.floats;
      nodes.matrices.value = next.matrices;
      nodes.scaled.value = next.scaled;
      nodes.indices.value = next.indices;
      nodes.fades.value = next.fades;
      nodes.counts.value = next.counts;
      nodes.occupied.value = next.occupied;
      nodes.draws.value = next.draws;
      nodes.args.value = next.args;
      rowCount.value = rows;
      indirect.dispatchSize = [Math.max(Math.ceil(rows / LANES), 1), 1, 1];
    },
    dispose(): void {
      update.dispose();
      indirect.dispose();
    },
  };
}

export type SortPasses = ReturnType<typeof sortPasses>;

/** The storage nodes of `buffers`, as the passes read and write them. */
function nodesOf(buffers: SortBuffers) {
  return {
    words: storage(buffers.words, "uint", 0).setName("lodRowWords").toReadOnly(),
    floats: storage(buffers.floats, "float", 0).setName("lodRowFloats").toReadOnly(),
    matrices: storage(buffers.matrices, "mat4", 0).setName("lodPoolMatrices").toReadOnly(),
    scaled: storage(buffers.scaled, "mat4", 0).setName("lodScaledMatrices"),
    indices: storage(buffers.indices, "uint", 0).setName("lodSlotIndices"),
    fades: storage(buffers.fades, "float", 0).setName("lodSlotFades"),
    counts: storage(buffers.counts, "uint", 0).setName("lodCounts").toAtomic(),
    occupied: storage(buffers.occupied, "uint", 0).setName("lodOccupied").toReadOnly(),
    draws: storage(buffers.draws, "uvec4", 0).setName("lodDraws").toReadOnly(),
    args: storage(buffers.args, "uint", 0).setName("lodDrawArgs"),
  };
}

type Nodes = ReturnType<typeof nodesOf>;

/** Lanes per workgroup of the indirect pass, one per row. */
const LANES = 64;

/** WebGPU's guaranteed maxComputeWorkgroupsPerDimension. */
const MAX_WORKGROUPS = 65535;

/** Row `row`'s values, by name, read from the camera's rows of u32s and of f32s. */
function rowOf(nodes: Nodes, row: Node<"uint">) {
  const base = row.mul(INT_ROW * 4).toVar();
  const floats = row.mul(FLOAT_ROW * 4).toVar();
  const u = (k: number, c: number) => nodes.words.element(base.add(k * 4 + c)).toVar();
  const f = (k: number, c: number) => nodes.floats.element(floats.add(k * 4 + c));
  const f4 = (k: number) => vec4(f(k, 0), f(k, 1), f(k, 2), f(k, 3)).toVar();
  const eye = f4(FLOATS_AT.eye);
  const values = f4(FLOATS_AT.values);
  return {
    count: int(u(INTS_AT.levels, 0)),
    coarsest: int(u(INTS_AT.levels, 1)),
    forced: int(u(INTS_AT.levels, 2)).sub(1), // see forcedWord
    sorting: u(INTS_AT.levels, 3),
    empty: u(INTS_AT.masks, 0),
    fades: u(INTS_AT.masks, 1),
    loaded: u(INTS_AT.masks, 2),
    before: u(INTS_AT.masks, 3),
    ortho: u(INTS_AT.flags, 0),
    culled: u(INTS_AT.flags, 1),
    survivors: u(INTS_AT.flags, 2),
    drawCount: u(INTS_AT.flags, 3),
    listSize: u(INTS_AT.layout, 0),
    drawBase: u(INTS_AT.layout, 1),
    /** The first slot of level `level`'s list, `UNLISTED` for none. */
    start: (level: Node<"uint">) => nodes.words.element(base.add(INTS_AT.starts * 4).add(level)),
    low: f4(FLOATS_AT.low),
    high: f4(FLOATS_AT.high),
    eye: eye.xyz,
    scale: eye.w,
    source: f4(FLOATS_AT.source),
    progress: values.x,
    reach: values.y,
    near: values.z,
    far: values.w,
    cullEye: f4(FLOATS_AT.cullEye).xyz,
    planes: Array.from({ length: 6 }, (_, i) => f4(FLOATS_AT.planes + i)),
  };
}

/**
 * The instance at `poolIndex`, of row `row`'s InstancedLod, sorted into the lists of the levels it draws for the camera
 * whose rows `nodes` read, if the row is sorting. Stateless: everything it reads and writes is in `nodes`.
 */
function updateInstance(nodes: Nodes, row: Node<"uint">, poolIndex: Node<"uint">): void {
  const r = rowOf(nodes, row);
  If(r.sorting.equal(0), () => void Return());
  const { count, coarsest, forced, empty, fades, loaded, before, eye, scale, progress, reach, near, far, ortho, culled, survivors, low, high } = r;
  const m = nodes.matrices.element(poolIndex).toVar();
  const hide = () => void Return();
  If(maxScale(m).equal(0), hide);
  const grow = float(1).toVar();
  If(culled.equal(uint(1)), () => {
    const origin = column(m, 3).xyz.toVar();
    grow.assign(cullScaleNode({ origin, distance: distance(origin, r.cullEye), near, far, survivors }));
    If(grow.equal(0), hide);
    If(survivors.equal(uint(1)), () => {
      const scaled = mat4(column(m, 0).mul(grow), column(m, 1).mul(grow), column(m, 2).mul(grow), column(m, 3));
      nodes.scaled.element(poolIndex).assign(scaled);
    });
  });
  const onScreen = instanceOnScreenNode({ matrix: m, source: r.source, grow, eye, scale, ortho }).toVar();
  const centre = onScreen.xyz;
  // Outside the camera's frustum: wholly behind one of its planes, with every level and its sway.
  const extent = reach
    .mul(stretch(m))
    .mul(grow)
    .mul(1 + 1e-4)
    .negate();
  for (const plane of r.planes) If(dot(plane.xyz, centre).add(plane.w).lessThan(extent), hide);
  const height = onScreen.w;
  const drawn = levelsToDrawNode({ height, count, low, high, empty, coarsest, forced, fades, loaded, before, progress }).toVar();
  const level = int(drawn.x).toVar();
  const finer = int(drawn.y).toVar();
  const fade = drawn.z.toVar();
  const { listSize } = r;
  /** Append the instance to level `index`'s list with `signed`, if the level has one and its list has room. */
  const append = (index: Node<"int">, signed: Node<"float">) => {
    const at = uint(index).toVar();
    const start = r.start(at).toVar();
    If(start.notEqual(UNLISTED), () => {
      const k = atomicAdd(nodes.counts.element(row.mul(COUNTS_PER_ROW).add(at)), uint(1)).toVar();
      If(k.lessThan(listSize), () => {
        const slot = start.add(k).toVar();
        nodes.indices.element(slot).assign(poolIndex);
        nodes.fades.element(slot).assign(signed);
      });
    });
  };
  If(level.greaterThanEqual(0), () => append(level, fade));
  // The finer neighbour fading out with it.
  If(finer.greaterThanEqual(0).and(fade.greaterThan(0)), () => append(finer, fade.negate()));
}

/**
 * Hands each level's count of row `row`, if sorting, to the indirect draws of its meshes (at most its list's slots),
 * and clears its counts for the next camera.
 */
function writeDraws(nodes: Nodes, row: Node<"uint">): void {
  const r = rowOf(nodes, row);
  If(r.sorting.equal(0), () => void Return());
  const { listSize, drawBase } = r;
  Loop({ start: uint(0), end: r.drawCount, type: "uint", condition: "<" }, ({ i }) => {
    const draw = nodes.draws.element(drawBase.add(i)).toVar();
    const first = r.start(draw.x).toVar();
    const base = drawBase
      .add(i)
      .mul(DRAW_BYTES / 4)
      .toVar();
    const words = nodes.args;
    // Indexed: count, instances, first index, base vertex, first instance; else count, instances, first vertex, first
    // instance and an unused word.
    words.element(base).assign(draw.y);
    const held = atomicLoad(nodes.counts.element(row.mul(COUNTS_PER_ROW).add(draw.x))).toVar();
    words.element(base.add(1)).assign(held.lessThan(listSize).select(held, listSize));
    words.element(base.add(2)).assign(draw.z);
    words.element(base.add(3)).assign(draw.w.equal(1).select(uint(0), first));
    words.element(base.add(4)).assign(draw.w.equal(1).select(first, uint(0)));
  });
  Loop({ start: uint(0), end: uint(COUNTS_PER_ROW), type: "uint", condition: "<" }, ({ i }) => {
    atomicStore(nodes.counts.element(row.mul(COUNTS_PER_ROW).add(i)), uint(0));
  });
}

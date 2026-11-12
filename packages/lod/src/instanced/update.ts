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
  int,
  localId,
  mat4,
  storage,
  uint,
  vec4,
  workgroupId,
} from "three/tsl";
import { MAX_LEVELS, levelsToDrawNode } from "../levels/draw.js";
import { column, maxScale, stretch } from "../tsl.js";
import { toTsl } from "../typegpu.js";
import { cullScale, instanceOnScreen } from "./measure.js";
import { BLOCKS_AT, DRAW_BYTES, FLOATS_AT, INTS_AT, NO_LIVE_COUNT, UNLISTED } from "./rows.js";

// Sorting a Lod's instances into its levels' instance lists for one camera, on the GPU, in two passes it builds once
// (see sort.ts).
//
// One workgroup per block of `BLOCK` instances of the ranges the camera sees (see clusters.ts), one lane per instance:
// a lane at or past its range's live count, if it has one, returns at once; updateInstance skips an instance at scale
// 0, thins it out by `cullDistance`, skips it outside the camera's frustum, measures its height on screen from its
// matrix with instanceOnScreen, picks what it draws with levelsToDraw, the function the CPU runs too, and appends itself
// to each level it draws: its index and signed fade go to that level's next free slot. Each level that draws something
// has a list of `listSize` slots, from the start the row gives; the level's draws start there (their first instance).
// The indirect pass hands each level's count to the indirect draws of the Lod's meshes and clears the counts for the
// next camera. Both stay within WebGPU's default limit of 8 storage buffers per stage, the blocks sharing the row's
// u32s' buffer.

const cullScaleNode = toTsl("lodCullScale", ["origin", "distance", "near", "far", "survivors"], cullScale);
const instanceOnScreenNode = toTsl("lodInstanceOnScreen", ["matrix", "source", "grow", "eye", "scale", "ortho"], instanceOnScreen);

/** Instances per block of a range, one workgroup's lanes. */
export const BLOCK = 64;

/** WebGPU's guaranteed maxComputeWorkgroupsPerDimension: the most blocks one sort visits. */
export const MAX_BLOCKS = 65535;

/** The buffers the sort passes read and write: pointed at a camera's (row, blocks, lists, args) as it sorts. */
export interface SortBuffers {
  /** The camera's row, its u32s followed by its blocks, and its f32s (see rows.ts). */
  words: StorageBufferAttribute;
  floats: StorageBufferAttribute;
  /** The live counts of the ranges the camera sorts (see `LodCluster.liveCount`). */
  liveCounts: StorageBufferAttribute;
  /** The instances' matrices, and survivors' scaled ones, which the level meshes draw while survivors scale. */
  matrices: StorageInstancedBufferAttribute;
  scaled: StorageInstancedBufferAttribute;
  /** The camera's slots: per slot, the instance it draws and its signed fade. */
  indices: StorageBufferAttribute;
  fades: StorageBufferAttribute;
  /** Per level, how many instances it holds for the camera: counted by updateInstance, cleared by the indirect pass. */
  counts: StorageBufferAttribute;
  /** The Lod's draws (see `drawWords` in rows.ts). */
  draws: StorageBufferAttribute;
  /** The camera's indirect draws, five words each, in the order of `draws`. */
  args: IndirectStorageBufferAttribute;
}

/** The sort passes over `buffers`, their nodes pointed at other buffers by `point`. */
export function sortPasses(buffers: SortBuffers) {
  const nodes = nodesOf(buffers);
  const update = computeKernel(
    Fn(() => {
      const block = workgroupId.x.mul(4).add(BLOCKS_AT).toVar();
      const word = (i: number) => nodes.words.element(block.add(i)).toVar();
      const [first, end, start, live] = [word(0), word(1), word(2), word(3)];
      const index = first.add(localId.x).toVar();
      If(index.greaterThanEqual(end), () => void Return());
      If(live.notEqual(NO_LIVE_COUNT), () => {
        If(index.sub(start).greaterThanEqual(nodes.liveCounts.element(live)), () => void Return());
      });
      updateInstance(nodes, index);
    })(),
    [BLOCK],
  );
  const indirect = computeKernel(
    Fn(() => writeDraws(nodes))(),
    [1],
  );
  indirect.dispatchSize = [1, 1, 1];
  return {
    update,
    indirect,
    /** Point the passes at `next`, dispatching the update pass over its `blocks` blocks: before they run. */
    point(next: SortBuffers, blocks: number): void {
      nodes.words.value = next.words;
      nodes.floats.value = next.floats;
      nodes.liveCounts.value = next.liveCounts;
      nodes.matrices.value = next.matrices;
      nodes.scaled.value = next.scaled;
      nodes.indices.value = next.indices;
      nodes.fades.value = next.fades;
      nodes.counts.value = next.counts;
      nodes.draws.value = next.draws;
      nodes.args.value = next.args;
      update.dispatchSize = [blocks, 1, 1];
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
    liveCounts: storage(buffers.liveCounts, "uint", 0).setName("lodLiveCounts").toReadOnly(),
    matrices: storage(buffers.matrices, "mat4", 0).setName("lodMatrices").toReadOnly(),
    scaled: storage(buffers.scaled, "mat4", 0).setName("lodScaledMatrices"),
    indices: storage(buffers.indices, "uint", 0).setName("lodSlotIndices"),
    fades: storage(buffers.fades, "float", 0).setName("lodSlotFades"),
    counts: storage(buffers.counts, "uint", 0).setName("lodCounts").toAtomic(),
    draws: storage(buffers.draws, "uvec4", 0).setName("lodDraws").toReadOnly(),
    args: storage(buffers.args, "uint", 0).setName("lodDrawArgs"),
  };
}

type Nodes = ReturnType<typeof nodesOf>;

/** The row's values, by name. */
function rowOf(nodes: Nodes) {
  const u = (k: number, c: number) => nodes.words.element(k * 4 + c).toVar();
  const f = (k: number, c: number) => nodes.floats.element(k * 4 + c);
  const f4 = (k: number) => vec4(f(k, 0), f(k, 1), f(k, 2), f(k, 3)).toVar();
  const eye = f4(FLOATS_AT.eye);
  const values = f4(FLOATS_AT.values);
  return {
    count: int(u(INTS_AT.levels, 0)),
    coarsest: int(u(INTS_AT.levels, 1)),
    forced: int(u(INTS_AT.levels, 2)).sub(1), // see forcedWord
    empty: u(INTS_AT.masks, 0),
    fades: u(INTS_AT.masks, 1),
    loaded: u(INTS_AT.masks, 2),
    before: u(INTS_AT.masks, 3),
    ortho: u(INTS_AT.flags, 0),
    culled: u(INTS_AT.flags, 1),
    survivors: u(INTS_AT.flags, 2),
    drawCount: u(INTS_AT.flags, 3),
    listSize: u(INTS_AT.layout, 0),
    /** The first slot of level `level`'s list, `UNLISTED` for none. */
    start: (level: Node<"uint">) => nodes.words.element(uint(INTS_AT.starts * 4).add(level)),
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

/** Instance `index`, sorted into the lists of the levels it draws for the camera whose row `nodes` read. */
function updateInstance(nodes: Nodes, index: Node<"uint">): void {
  const r = rowOf(nodes);
  const { count, coarsest, forced, empty, fades, loaded, before, eye, scale, progress, reach, near, far, ortho, culled, survivors, low, high } = r;
  const m = nodes.matrices.element(index).toVar();
  const hide = () => void Return();
  If(maxScale(m).equal(0), hide);
  const grow = float(1).toVar();
  If(culled.equal(uint(1)), () => {
    const origin = column(m, 3).xyz.toVar();
    grow.assign(cullScaleNode({ origin, distance: distance(origin, r.cullEye), near, far, survivors }));
    If(grow.equal(0), hide);
    If(survivors.equal(uint(1)), () => {
      const scaled = mat4(column(m, 0).mul(grow), column(m, 1).mul(grow), column(m, 2).mul(grow), column(m, 3));
      nodes.scaled.element(index).assign(scaled);
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
  /** Append the instance to level `at`'s list with `signed`, if the level has one and its list has room. */
  const append = (at: Node<"int">, signed: Node<"float">) => {
    const level = uint(at).toVar();
    const start = r.start(level).toVar();
    If(start.notEqual(UNLISTED), () => {
      const k = atomicAdd(nodes.counts.element(level), uint(1)).toVar();
      If(k.lessThan(listSize), () => {
        const slot = start.add(k).toVar();
        nodes.indices.element(slot).assign(index);
        nodes.fades.element(slot).assign(signed);
      });
    });
  };
  If(level.greaterThanEqual(0), () => append(level, fade));
  // The finer neighbour fading out with it.
  If(finer.greaterThanEqual(0).and(fade.greaterThan(0)), () => append(finer, fade.negate()));
}

/** Hands each level's count to the indirect draws of its meshes (at most its list's slots), and clears the counts. */
function writeDraws(nodes: Nodes): void {
  const r = rowOf(nodes);
  const { listSize } = r;
  Loop({ start: uint(0), end: r.drawCount, type: "uint", condition: "<" }, ({ i }) => {
    const draw = nodes.draws.element(i).toVar();
    const first = r.start(draw.x).toVar();
    const base = i.mul(DRAW_BYTES / 4).toVar();
    const words = nodes.args;
    // Indexed: count, instances, first index, base vertex, first instance; else count, instances, first vertex, first
    // instance and an unused word.
    words.element(base).assign(draw.y);
    const held = atomicLoad(nodes.counts.element(draw.x)).toVar();
    words.element(base.add(1)).assign(held.lessThan(listSize).select(held, listSize));
    words.element(base.add(2)).assign(draw.z);
    words.element(base.add(3)).assign(draw.w.equal(1).select(uint(0), first));
    words.element(base.add(4)).assign(draw.w.equal(1).select(first, uint(0)));
  });
  Loop({ start: uint(0), end: uint(MAX_LEVELS), type: "uint", condition: "<" }, ({ i }) => {
    atomicStore(nodes.counts.element(i), uint(0));
  });
}

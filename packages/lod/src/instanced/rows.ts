import { IndirectStorageBufferAttribute, StorageBufferAttribute } from "three/webgpu";
import { MAX_LEVELS } from "../levels/draw.js";

// What a Lod sorts by for one camera, as the sort passes read it (see update.ts): its row, of u32s and of f32s, and
// after the row's u32s, in their buffer, the blocks of instances it sorts.

/** vec4s of the row's u32s and of its f32s. */
export const INT_ROW = 6;
export const FLOAT_ROW = 12;

/**
 * Where each vec4 of the row lies. Of its u32s (`INTS_AT`): `levels`, the level count, the coarsest level and the forced
 * level as `forcedWord` writes it; `masks`, the levels that draw nothing, whether they fade (1 or 0), those loaded and
 * those loaded before; `flags`, whether the camera is orthographic, cullDistance is set and its survivors scale (1 or
 * 0), and the draw count; `layout`, slots per list; `starts`, per level the first slot of its list, `UNLISTED` for none.
 * Of its f32s (`FLOATS_AT`): maxPixels of levels 0 to 3 and 4 to 7, the camera in the Lod's space (eye and pixels per
 * unit of subtense, or of size, ortho), one instance's source sphere, the arrival's progress, the reach of every level
 * and its sway, cullDistance's near and far, cullDistance's camera, and the frustum's six planes.
 */
export const INTS_AT = { levels: 0, masks: 1, flags: 2, layout: 3, starts: 4 } as const;
export const FLOATS_AT = { low: 0, high: 1, eye: 2, source: 3, values: 4, cullEye: 5, planes: 6 } as const;

/** The forced level as the row holds it: one more, so that 0 is none (-1). */
export const forcedWord = (forced: number) => forced + 1;

/** The start of a level without a list. */
export const UNLISTED = 0xffffffff;

/** Bytes per indirect draw, including the unused final word of a non-indexed draw. */
export const DRAW_BYTES = 20;

/** One indirect draw: a level's mesh, drawing `count` indices (or vertices) from `start`. */
export interface IndirectDraw {
  level: number;
  count: number;
  start: number;
  indexed: boolean;
}

/** The words of `draws` as the indirect pass reads them: level, count, start and whether indexed, per draw. */
export function drawWords(draws: readonly IndirectDraw[]): StorageBufferAttribute {
  const values = new Uint32Array(Math.max(draws.length, 1) * 4);
  draws.forEach((draw, i) => values.set([draw.level, draw.count, draw.start, Number(draw.indexed)], i * 4));
  return new StorageBufferAttribute(values, 4);
}

/**
 * Where the blocks start among the u32s: four per block, its first instance, its range's end and start, and its range's
 * item of live counts, NO_LIVE_COUNT for none (see `LodCluster.liveCount`).
 */
export const BLOCKS_AT = INT_ROW * 4;
export const NO_LIVE_COUNT = 0xffffffff;

/** The row's u32s and room for `blocks` blocks, one at least. */
export const wordsBuffer = (blocks: number) => new StorageBufferAttribute(new Uint32Array(BLOCKS_AT + Math.max(blocks, 1) * 4), 4);
export const floatsBuffer = () => new StorageBufferAttribute(new Float32Array(FLOAT_ROW * 4), 4);
/** Per level, how many instances its list holds for the camera sorting: the indirect pass clears them. */
export const countsBuffer = () => new StorageBufferAttribute(new Uint32Array(MAX_LEVELS), 1);
/** Indirect draws only the GPU writes, zero until a sort writes them: nothing draws before a sort. */
export const argsBuffer = (draws: number) => new IndirectStorageBufferAttribute(new Uint32Array(Math.max(draws, 1) * (DRAW_BYTES / 4)), 1);

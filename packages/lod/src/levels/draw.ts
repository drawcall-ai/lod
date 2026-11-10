import { d, std, tgpu } from "typegpu";
import { toTsl } from "../typegpu.js";

// Which levels one object draws at a height, written once: Lod calls levelsToDraw as plain JS, InstancedLod runs the
// same function per instance on the GPU, resolved into WGSL by TypeGPU.

/** Share of each level's range over which its finer neighbour fades out. */
export const FADE = 0.1;

/**
 * The most levels a Lod or InstancedLod has. WGSL has no arrays of a size given at run time, so levelsToDraw reads
 * maxPixels from an array of this size, and the loaded sets are bits of one u32. The GPU side passes the array as two
 * vec4s, `low` and `high` (see `levelsToDrawNode`), which hold eight.
 */
export const MAX_LEVELS = 8;

/**
 * The largest f32, which stands for any height levelsToDraw reads, as the maxPixels of level 0's Infinity: an f32
 * holds Infinity, but WGSL has no literal for it and assumes finite math, so TypeGPU refuses to pass it.
 */
export const ANY_HEIGHT = 3.4028234663852886e38;

/**
 * The levels as levelsToDraw reads them, with the draw's settings: `maxPixels` per level, `empty` the bits of the
 * levels that draw nothing, `coarsest` the coarsest level that draws something (level 0 if none does), `forced` the
 * level every draw shows or -1, and `fades` 1 where levels fade (not in an orthographic camera or with a forced level),
 * else 0.
 */
export const DrawLevels = d.struct({
  count: d.i32,
  maxPixels: d.arrayOf(d.f32, MAX_LEVELS),
  empty: d.u32,
  coarsest: d.i32,
  forced: d.i32,
  fades: d.u32,
});

/** Whether bit `level` of `bits` is set: the levels of a set, such as the loaded ones, are bits of one number. */
export const has = (bits: number, level: number): boolean => ((bits >>> level) & 1) === 1;

/** `levels` as levelsToDraw reads them, on the CPU and in the GPU's uniforms; `forced` a forced level or null. */
export function drawLevels(levels: readonly { maxPixels: number }[], empty: number, forced: number | null, fades: boolean): d.Infer<typeof DrawLevels> {
  const maxPixels = Array.from({ length: MAX_LEVELS }, (_, i) => Math.min(levels[i]?.maxPixels ?? 0, ANY_HEIGHT));
  let coarsest = 0;
  for (let i = 1; i < levels.length; i++) if (!has(empty, i)) coarsest = i;
  return { count: levels.length, maxPixels, empty, coarsest, forced: forced ?? -1, fades: forced === null && fades ? 1 : 0 };
}

/**
 * What one object draws: `level` with the signed fade `fade`, and `finer` with `-fade` (see fade.ts), so that each
 * pixel is drawn by exactly one of them; with `fade` 0 only `level` draws. `level` -1 draws nothing.
 */
export const Draw = d.struct({ level: d.i32, finer: d.i32, fade: d.f32 });

/**
 * The level that draws most of an object's pixels in `draw`, or null for none. `level` keeps 1 - fade of them and
 * `finer` fade (see fade.ts), so `finer` once fade is above one half; at one half exactly, `level`.
 */
export function drawnLevel({ level, finer, fade }: d.Infer<typeof Draw>): number | null {
  if (level < 0) return null;
  return fade > 0.5 ? finer : level;
}

/** The GPU twin of `has` above, in code TypeGPU resolves: whether bit `index` of `bits` is set. */
const gpuHas = tgpu.fn(
  [d.u32, d.i32],
  d.bool,
)((bits, index) => {
  "use gpu";
  return ((bits >>> d.u32(index)) & 1) === 1;
});

/**
 * Level `level`'s maxPixels. The array is walked rather than indexed: TypeScript types an index as possibly
 * undefined, and code TypeGPU resolves cannot narrow it.
 */
const maxPixelsOf = tgpu.fn(
  [DrawLevels, d.i32],
  d.f32,
)((levels, level) => {
  "use gpu";
  let found = d.f32(0);
  let i = d.i32(0);
  for (const maxPixels of levels.maxPixels) {
    if (i === level) found = maxPixels;
    i += 1;
  }
  return found;
});

/** The level a `height` px tall object is drawn at: the last one whose maxPixels it fits; level 0 fits any height. */
export const levelForHeight = tgpu.fn(
  [d.f32, DrawLevels],
  d.i32,
)((height, levels) => {
  "use gpu";
  let level = d.i32(0);
  let i = d.i32(0);
  for (const maxPixels of levels.maxPixels) {
    if (i > 0 && i < levels.count && height <= maxPixels) level = i;
    i += 1;
  }
  return level;
});

/** `level` once loaded, else the nearest loaded coarser level that draws something, else -1: never a finer one. */
export const loadedOrCoarser = tgpu.fn(
  [d.i32, DrawLevels, d.u32],
  d.i32,
)((level, levels, loaded) => {
  "use gpu";
  if (gpuHas(loaded, level)) return level;
  for (let i = level + 1; i < levels.count; i++) {
    if (gpuHas(loaded, i) && !gpuHas(levels.empty, i)) return i;
  }
  return -1;
});

/** What an object `height` px tall draws once the levels of `loaded` are loaded, with no arrival under way. */
const settled = tgpu.fn(
  [d.f32, DrawLevels, d.u32],
  Draw,
)((height, levels, loaded) => {
  "use gpu";
  // Nothing draws before the coarsest level that draws something: an object never vanishes as its camera backs away.
  if (!gpuHas(loaded, levels.coarsest)) return Draw({ level: -1, finer: -1, fade: 0 });
  let chosen = levels.forced;
  let fade = d.f32(0);
  if (chosen < 0) {
    chosen = levelForHeight(height, levels);
    if (levels.fades === 1 && chosen > 0) {
      const top = maxPixelsOf(levels, chosen);
      fade = std.smoothstep(top * (1 - FADE), top, height);
    }
  }
  const level = loadedOrCoarser(chosen, levels, loaded);
  if (level < 0) return Draw({ level: -1, finer: -1, fade: 0 });
  let finer = level;
  if (fade > 0 && gpuHas(loaded, chosen - 1)) finer = chosen - 1;
  if (finer === level) fade = 0;
  return Draw({ level, finer, fade });
});

/**
 * What an object `height` px tall draws: its level by height (or `levels.forced`), and inside the top FADE of that
 * level's range its finer neighbour too, each as `loaded` has them (see `loadedOrCoarser`). Nothing draws until the
 * coarsest level that draws something has loaded.
 *
 * While a level arrives, `progress` runs from 0 to 1 over the arrival (1 when none is under way) from what the levels
 * of `before` drew to what those of `loaded` draw, with two draws only: the old height fade collapses onto one level,
 * that level hands its pixels to the new one, and the new height fade opens. What arrives where nothing drew draws at
 * once.
 */
export const levelsToDraw = tgpu.fn(
  [d.f32, DrawLevels, d.u32, d.u32, d.f32],
  Draw,
)((height, levels, loaded, before, progress) => {
  "use gpu";
  const after = settled(height, levels, loaded);
  if (progress >= 1) return after;
  const from = settled(height, levels, before);
  if (from.level < 0 || (from.level === after.level && from.finer === after.finer)) return after;
  let level = after.level;
  let finer = after.finer;
  let fade = d.f32(0);
  if (progress < 1 / 3) {
    level = from.level;
    finer = from.finer;
    if (from.fade > 0) fade = from.fade + (1 - from.fade) * progress * 3;
  } else if (progress < 2 / 3) {
    level = std.select(after.level, after.finer, after.fade > 0);
    finer = std.select(from.level, from.finer, from.fade > 0);
    fade = 1 - (progress - 1 / 3) * 3;
  } else if (after.fade > 0) {
    fade = 1 - (1 - after.fade) * (progress - 2 / 3) * 3;
  }
  if (level === finer) fade = 0;
  return Draw({ level, finer, fade });
});

// drawnOf passes maxPixels as two vec4s, `low` and `high`.
if (MAX_LEVELS !== 8) throw new Error("Lod: levelsToDraw's WGSL passes maxPixels as two vec4s: MAX_LEVELS must be 8");

/**
 * levelsToDraw of the levels as `drawLevels` encodes them, with `low` and `high` holding maxPixels of levels 0 to 3 and
 * 4 to 7: a vec3 of the level, the finer level (as floats) and the fade.
 */
const drawnOf = tgpu.fn(
  [d.f32, d.i32, d.vec4f, d.vec4f, d.u32, d.i32, d.i32, d.u32, d.u32, d.u32, d.f32],
  d.vec3f,
)((height, count, low, high, empty, coarsest, forced, fades, loaded, before, progress) => {
  "use gpu";
  const maxPixels = d.arrayOf(d.f32, MAX_LEVELS)([low.x, low.y, low.z, low.w, high.x, high.y, high.z, high.w]);
  const drawn = levelsToDraw(height, DrawLevels({ count, maxPixels, empty, coarsest, forced, fades }), loaded, before, progress);
  return d.vec3f(d.f32(drawn.level), d.f32(drawn.finer), drawn.fade);
});

/** drawnOf on the GPU, from its inputs as TSL nodes. */
export const levelsToDrawNode = toTsl(
  "lodDraw",
  ["height", "count", "low", "high", "empty", "coarsest", "forced", "fades", "loaded", "before", "progress"],
  drawnOf,
);

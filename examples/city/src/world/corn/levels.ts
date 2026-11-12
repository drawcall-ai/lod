import { Lod } from "@drawcall/lod";

/**
 * The thresholds the corn plant's ladder (public/corn/index.glts) is loaded with: where the detailed impostor takes
 * over from the source, the coarse one from it, and the plant is gone, unless setCutoff moves the last two.
 */
const PLANT_PIXELS = 1000;
const FAR_PIXELS = 350;
const PLANT_GONE = 215;

/** Leave two complete fades between full geometry and an empty crowded field tile. */
export function cutoff(squeeze: number): number {
  return Math.min(PLANT_GONE * squeeze, PLANT_PIXELS * (1 - Lod.fade) ** 2 * 0.99);
}

export function setCutoff(levels: readonly { maxPixels: number }[], gone: number): void {
  const coarse = levels.at(-2),
    empty = levels.at(-1);
  if (levels.length !== 4 || !coarse || !empty) throw new Error("Corn needs source, detailed impostor, coarse impostor and empty levels");
  coarse.maxPixels = Math.max(FAR_PIXELS, gone / (1 - Lod.fade));
  empty.maxPixels = gone;
}

import { Lod } from "@drawcall/lod";

export const PLANT_PIXELS = 1000;
export const FAR_PIXELS = 350;
export const PLANT_GONE = 215;

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

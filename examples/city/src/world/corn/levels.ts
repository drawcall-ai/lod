import { CachedLodLoader, foliageLevels, Lod, type LodLevel } from "@drawcall/lod";
import { LEAF_FOLIAGE } from "../../../public/corn/leaf.ts";
import { VARIANTS } from "../../../public/corn/layout.ts";
import { arriving, manager } from "../../loading.ts";

/**
 * The thresholds the plant ladders below are loaded with, which loads repeat as literals: where the detailed impostor
 * takes over from the source, the coarse one from it, and the plant is gone, unless setCutoff moves the last two.
 */
const PLANT_PIXELS = 1000;
const FAR_PIXELS = 350;
const PLANT_GONE = 215;

/** Only the source casts shadows. */
const options = arriving((object, index) => {
  foliageLevels(object, LEAF_FOLIAGE);
  if (index > 0) object.castShadow = false;
});

/** Each plant variant's ladder, in the shape setCutoff moves. */
export const PLANTS: (() => Promise<LodLevel[]>)[] = [
  () =>
    new CachedLodLoader(manager, options).loadAsync({
      url: "/corn/index.glts?variant=0",
      levels: [
        { type: "impostor", layout: "hemi", maxPixels: 1000, resolution: 256, frames: 8, draw: { parallax: 0 } },
        { type: "impostor", layout: "hemi", maxPixels: 350, resolution: 64, frames: 8, draw: { parallax: 0 } },
        { type: "empty", maxPixels: 215 },
      ],
    }),
  () =>
    new CachedLodLoader(manager, options).loadAsync({
      url: "/corn/index.glts?variant=1",
      levels: [
        { type: "impostor", layout: "hemi", maxPixels: 1000, resolution: 256, frames: 8, draw: { parallax: 0 } },
        { type: "impostor", layout: "hemi", maxPixels: 350, resolution: 64, frames: 8, draw: { parallax: 0 } },
        { type: "empty", maxPixels: 215 },
      ],
    }),
  () =>
    new CachedLodLoader(manager, options).loadAsync({
      url: "/corn/index.glts?variant=2",
      levels: [
        { type: "impostor", layout: "hemi", maxPixels: 1000, resolution: 256, frames: 8, draw: { parallax: 0 } },
        { type: "impostor", layout: "hemi", maxPixels: 350, resolution: 64, frames: 8, draw: { parallax: 0 } },
        { type: "empty", maxPixels: 215 },
      ],
    }),
  () =>
    new CachedLodLoader(manager, options).loadAsync({
      url: "/corn/index.glts?variant=3",
      levels: [
        { type: "impostor", layout: "hemi", maxPixels: 1000, resolution: 256, frames: 8, draw: { parallax: 0 } },
        { type: "impostor", layout: "hemi", maxPixels: 350, resolution: 64, frames: 8, draw: { parallax: 0 } },
        { type: "empty", maxPixels: 215 },
      ],
    }),
];

if (PLANTS.length !== VARIANTS) throw new Error(`levels.ts loads ${PLANTS.length} corn plant variants of ${VARIANTS}`);

/** The plant the tour ends at, with every leaf in detail. */
export const loadHero = () =>
  new CachedLodLoader(manager, options).loadAsync({
    url: "/corn/index.glts?variant=2&hero=1",
    levels: [
      { type: "impostor", layout: "hemi", maxPixels: 1000, resolution: 256, frames: 8, draw: { parallax: 0 } },
      { type: "impostor", layout: "hemi", maxPixels: 350, resolution: 64, frames: 8, draw: { parallax: 0 } },
      { type: "empty", maxPixels: 215 },
    ],
  });

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

import { Lod, type LodRequest } from "@drawcall/lod";
import { foliageLevels } from "../../../public/content/foliage.ts";
import { LEAF_FOLIAGE } from "../../../public/content/corn/leaf.ts";
import { FAR_PIXELS, PLANT_GONE, PLANT_PIXELS, type Ladder } from "../../../public/content/ladders.ts";

/** A corn plant's ladder, in the shape setCutoff moves. Only the source casts shadows. */
export function plantRequest(ladder: Ladder): LodRequest {
  return {
    ...ladder,
    onLevel: (object, index) => {
      foliageLevels(object, LEAF_FOLIAGE);
      if (index > 0) object.castShadow = false;
    },
  };
}

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

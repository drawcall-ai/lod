import { CacheEntry, type CacheEntryOptions, type Value } from "@drawcall/cache";
import type { BlockFormat } from "../blocks/index.js";
import type { Derived } from "./level.js";
import { derived, inferredImpostor, type Ladder } from "./request.js";

// What a level is stored under.

/**
 * What builds and lays out a stored level, and so what identifies it beside its request: bump it with any change to
 * the bytes a level or shape entry holds.
 */
const version = "lod-level@28";

/**
 * The entry of derived level `of` of `ladder` with its maps in `format`, or of its source's shape, keyed by the request
 * alone. A level with maps is stored once per block format; a simplified level, which has none, once.
 */
export function entryOf(
  ladder: Ladder,
  of: number | "shape" | "ladder",
  { basePath, root }: Pick<CacheEntryOptions, "basePath" | "root">,
  format: BlockFormat | null = null,
): CacheEntry {
  const level = typeof of === "number" ? parameters(derived(ladder.levels, of)) : { type: "shape" };
  // Only inferred impostors need a ladder-specific shape. The others share the source shape.
  const fits = of === "ladder" ? ladder.levels.filter(inferredImpostor).map(parameters) : [];
  return new CacheEntry({
    basePath,
    root,
    version,
    dependencies: { level: { value: { url: ladder.key, level, ...(fits.length > 0 && { fits }), ...(format && { format }) } } },
  });
}

/**
 * What derives a level's content, by its role rather than its ladder position, so adding or removing another level
 * keeps this one's entry. Runtime draw options do not affect the entry.
 */
function parameters(level: Derived): Value {
  switch (level.type) {
    case "simplify":
      return {
        type: level.type,
        ratio: level.ratio ?? null,
        ...(level.maxPixels !== undefined && Number.isFinite(level.maxPixels) && level.ratio !== 1 && { maxPixels: level.maxPixels }),
      };
    case "baked":
      return {
        type: level.type,
        ratio: level.ratio ?? null,
        textureSize: level.textureSize ?? null,
        low: level.low ?? null,
        interior: level.interior ?? null,
      };
    case "impostor":
      return {
        type: level.type,
        // The impostor reads its textures for this height, at every mip.
        maxPixels: level.maxPixels ?? null,
        layout: level.layout ?? null,
        frames: level.frames ?? null,
        resolution: level.resolution ?? null,
        emissive: level.emissive ?? null,
        supersample: level.supersample ?? null,
      };
  }
}

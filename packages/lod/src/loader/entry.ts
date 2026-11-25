import { CacheEntry, type CacheEntryOptions, type Value } from "@drawcall/cache";
import type { BlockFormat } from "../blocks/index.js";
import { cardError } from "../simplify/options.js";
import type { Derived } from "./level.js";
import { derived, inferredImpostor, type Ladder } from "./request.js";

// What a level is stored under.

/**
 * What builds and lays out a stored level, and so what identifies it beside its request: bump it with any change to
 * the bytes a level or shape entry holds.
 */
const version = "lod-level@29";

/**
 * The entry of derived level `of` of `ladder` with its maps in `format`, or of its shape, keyed by the request alone. A
 * level with maps is stored once per block format; a simplified level, which has none, once. A shape holds the
 * `texelPixels` of the impostors without `maxPixels`, so their requests key it too.
 */
export function entryOf(
  ladder: Ladder,
  of: number | "shape",
  { basePath, root }: Pick<CacheEntryOptions, "basePath" | "root">,
  format: BlockFormat | null = null,
): CacheEntry {
  const level = of === "shape" ? { type: of, impostors: ladder.levels.filter(inferredImpostor).map(parameters) } : parameters(derived(ladder.levels, of));
  const value = { url: ladder.key, ...(ladder.source && { source: ladder.source }), level, ...(format && { format }) };
  return new CacheEntry({ basePath, root, version, dependencies: { level: { value } } });
}

/**
 * What derives a level's content, by its role rather than its ladder position, so adding or removing another level
 * keeps this one's entry. Switch heights and impostor draw options apply at decode, so changing one reuses it, except
 * the heights noted below.
 */
function parameters(level: Derived): Value {
  switch (level.type) {
    case "simplify":
      return {
        type: level.type,
        ratio: level.ratio ?? null,
        // A height that simplifies foliage cards.
        ...(cardError(level) > 0 && { maxPixels: level.maxPixels ?? null }),
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

import { CacheEntry, type CacheEntryOptions, type JsonValue } from "vitecache";
import type { Derived } from "./level.js";
import { derived, type Ladder } from "./request.js";

// What a level is stored under.

/**
 * What builds and lays out a stored level, and so what identifies it beside its request: bump it with any change to
 * the bytes a level or shape entry holds.
 */
const version = "lod-level@25";

/** The entry of derived level `of` of `ladder`, or of its source's shape, keyed by the request alone. */
export function entryOf(ladder: Ladder, of: number | "shape", { basePath, root }: Pick<CacheEntryOptions, "basePath" | "root">): CacheEntry {
  const level = of === "shape" ? { type: of } : parameters(derived(ladder.levels, of));
  return new CacheEntry({ basePath, root, version, dependencies: { level: { value: { url: ladder.key, level } } } });
}

/**
 * What derives a level's content, by its role rather than its ladder position, so adding or removing another level
 * keeps this one's entry. Switch thresholds and impostor draw options apply at decode, so changing one reuses it.
 */
function parameters(level: Derived): JsonValue {
  switch (level.type) {
    case "simplify":
      return { type: level.type, ratio: level.ratio ?? null };
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
        // The impostor bakes its top mip for this height too.
        maxPixels: level.maxPixels ?? null,
        layout: level.layout ?? null,
        frames: level.frames ?? null,
        resolution: level.resolution ?? null,
        emissive: level.emissive ?? null,
        supersample: level.supersample ?? null,
      };
  }
}

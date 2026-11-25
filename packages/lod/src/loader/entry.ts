import { CacheEntry, type CacheEntryOptions, type Value } from "@drawcall/cache";
import type { BlockFormat } from "../blocks/index.js";
import type { Derived } from "./level.js";
import { derived, inferredImpostor, type Ladder } from "./request.js";

// What a level is stored under.

/** Bump the version of the entry whose stored bytes change. */
const versions = { simplify: 29, baked: 29, impostor: 30, shape: 29 };

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
  const request = of === "shape" ? null : derived(ladder.levels, of);
  const level = request ? parameters(request) : { type: "shape", impostors: ladder.levels.filter(inferredImpostor).map(parameters) };
  const version = `lod-level@${versions[request?.type ?? "shape"]}`;
  const value = { url: ladder.key, ...(ladder.source && { source: ladder.source }), level, ...(format && { format }) };
  return new CacheEntry({ basePath, root, version, dependencies: { level: { value } } });
}

/**
 * What derives a level's content, by its role rather than its ladder position, so adding or removing another level
 * keeps this one's entry. Switch thresholds and impostor draw options apply at decode, so changing one reuses it,
 * except an impostor's `maxPixels`, which sizes its bake.
 */
function parameters(level: Derived): Value {
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

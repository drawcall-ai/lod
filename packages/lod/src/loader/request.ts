import type { ImpostorMeshOptions } from "../impostor/mesh/index.js";
import type { BakeImpostorOptions } from "../impostor/bake/index.js";
import type { SimplifyOptions } from "../simplify/index.js";
import type { Derived } from "./level.js";
import { loaderPathURL } from "./url.js";

// What a CachedLodLoader is asked for, normalised.

/**
 * Levels derived from the source, finest first. In browsers each derived level is built when it first loads; in Node
 * every level is built with the ladder. A level without `maxPixels` gets the default `LodLevel.maxPixels` describes;
 * a prebuilt impostor uses the sharpness of its fitted atlas. Without that measurement the loader estimates it from the bounding sphere.
 * A simplified level uses an explicit finite `maxPixels` to simplify the interiors of foliage cards. An impostor's
 * `maxPixels` sizes its bake.
 */
export type LodLevelRequest =
  | ({ type: "simplify" } & SimplifyOptions)
  | ({
      type: "baked";
      maxPixels?: number;
      textureSize?: number;
      /** Room geometry for window baking, as an asset URL relative to the source. */
      interior?: string;
    } & (
      | {
          /** Authored low shell to bake onto, as an asset URL relative to the source. */
          low: string;
          ratio?: never;
        }
      | { low?: never; ratio?: number }
    ))
  | ({ type: "impostor"; draw?: ImpostorMeshOptions } & BakeImpostorOptions)
  | { type: "empty"; maxPixels: number };

/** An impostor whose fitted atlas supplies the missing threshold. */
export function inferredImpostor(level: LodLevelRequest): level is Extract<LodLevelRequest, { type: "impostor" }> {
  return level.type === "impostor" && level.maxPixels === undefined;
}

/** A .glb, .gltf or .glts asset URL. Source and simplified levels load the original asset on demand. */
export type LodRequest = string | { url: string; levels?: readonly LodLevelRequest[] };
const DEFAULT_LEVELS: readonly LodLevelRequest[] = [{ type: "impostor" }];

/** A normalized request. */
export type Ladder = ReturnType<typeof normalize>;

/**
 * `request` with its source URL resolved against `path`, which loads it, and `key` of that, which its levels are stored
 * under. A baked level's low and interior URLs stay relative to the source.
 */
export function normalize(request: LodRequest, path: string, key: (url: string) => string) {
  const input = typeof request === "string" ? { url: request } : request;
  const url = loaderPathURL(input.url, path);
  return { url, key: key(url), levels: structuredClone(input.levels ?? DEFAULT_LEVELS) };
}

/** The request of ladder level `index`, which must be a derived level. */
export function derived(levels: readonly LodLevelRequest[], index: number): Derived {
  const level = levels[index - 1];
  if (!level || level.type === "empty") throw new Error(`CachedLodLoader: level ${index} is not derived`);
  return level;
}

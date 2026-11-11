import type { ImpostorMeshOptions } from "../impostor/mesh/index.js";
import type { BakeImpostorOptions } from "../impostor/bake/index.js";
import type { SimplifyOptions } from "../simplify/index.js";
import type { Derived } from "./level.js";
import { loaderPathURL, sourceRelativeURL } from "./url.js";

// What a CachedLodLoader is asked for, normalised.

/**
 * Levels derived from the source, finest first. In browsers each derived level is built when it first loads, except a
 * simplified or baked level without `maxPixels`, which is built with the ladder since its default threshold is measured
 * from its deviation; in Node every level is built with the ladder. An impostor's default is `framePixels` of its
 * resolution: the threshold of a frame fitted to the source's bounding sphere, so the level before it draws smaller
 * than it needs to. The frame the bake fits to the source is up to about 1.5 times tighter; give `maxPixels` to
 * switch to the impostor sooner. Changing `maxPixels` or an impostor's `draw` reuses them, except an impostor's
 * `maxPixels`, which also sizes its bake.
 */
export type LodLevelRequest =
  | ({ type: "simplify"; maxPixels?: number } & SimplifyOptions)
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

/** A .glb, .gltf or .glts asset URL. Source and simplified levels load the original asset on demand. */
export type LodRequest = string | { url: string; levels?: readonly LodLevelRequest[] };
const DEFAULT_LEVELS: readonly LodLevelRequest[] = [{ type: "impostor" }];

/** A normalized request. */
export type Ladder = ReturnType<typeof normalize>;

/** `request` with its source URL resolved against `path`, and a baked level's low and interior URLs against the source. */
export function normalize(request: LodRequest, path: string) {
  const input = typeof request === "string" ? { url: request } : request;
  const url = loaderPathURL(input.url, path);
  const levels = structuredClone(input.levels ?? DEFAULT_LEVELS).map((level) =>
    level.type === "baked" ? { ...level, ...resolved(level, "low", url), ...resolved(level, "interior", url) } : level,
  );
  return { url, levels };
}

/** `level`'s `name` URL resolved against `source`, as the fields to spread over it. */
function resolved(level: LodLevelRequest & { type: "baked" }, name: "low" | "interior", source: string) {
  const value = level[name];
  return value === undefined ? {} : { [name]: sourceRelativeURL(value, source) };
}

/** The request of ladder level `index`, which must be a derived level. */
export function derived(levels: readonly LodLevelRequest[], index: number): Derived {
  const level = levels[index - 1];
  if (!level || level.type === "empty") throw new Error(`CachedLodLoader: level ${index} is not derived`);
  return level;
}

import type { ImpostorMeshOptions } from "../impostor/mesh/index.js";
import type { BakeImpostorOptions } from "../impostor/bake/index.js";
import type { SimplifyOptions } from "../simplify/index.js";
import type { Derived } from "./level.js";
import { loaderPathURL, sourceRelativeURL } from "./url.js";

// What a CachedLodLoader is asked for, normalised.

/**
 * Levels derived from the source, finest first. Each derived level is built when it first loads; a simplified or
 * baked level without `maxPixels` is built with the ladder, since its default threshold is measured from its deviation. An impostor's default is `framePixels` of its
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

/** `request` with its URLs resolved against `path`, and every asset URL it builds from named by its role. */
export function normalize(request: LodRequest, path: string) {
  const input = typeof request === "string" ? { url: request } : request;
  const url = loaderPathURL(input.url, path);
  const levels = structuredClone(input.levels ?? DEFAULT_LEVELS);
  const urls: Record<string, string> = { source: url };
  levels.forEach((level, position) => {
    if (level.type !== "baked") return;
    for (const name of ["low", "interior"] as const) {
      const value = level[name];
      if (value !== undefined) urls[auxiliary(position + 1, name)] = sourceRelativeURL(value, url);
    }
  });
  return { url, levels, urls };
}

/** The request of ladder level `index`, which must be a derived level. */
export function derived(levels: readonly LodLevelRequest[], index: number): Derived {
  const level = levels[index - 1];
  if (!level || level.type === "empty") throw new Error(`CachedLodLoader: level ${index} is not derived`);
  return level;
}

/** The name of the low or interior asset of the baked level at ladder index `level`. */
export const auxiliary = (level: number, name: "low" | "interior") => `auxiliary:${level}:${name}`;

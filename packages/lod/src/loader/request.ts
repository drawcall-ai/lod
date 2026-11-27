import type { LoadingManager, Object3D } from "three/webgpu";
import type { CachedLodLoader } from "./index.js";
import type { ImpostorMeshOptions } from "../impostor/mesh/index.js";
import type { BakeImpostorOptions } from "../impostor/bake/index.js";
import type { SimplifyOptions } from "../simplify/index.js";
import type { Derived } from "./level.js";
import { loaderPathURL } from "./url.js";

// What a CachedLodLoader is asked for, normalised.

/**
 * Levels derived from the source, finest first. In browsers each derived level is built when it first loads; in Node
 * every level is built with the ladder. A level without `maxPixels` gets the default `LodLevel.maxPixels` describes;
 * an impostor's is `texelPixels` of its bake when Node described the ladder, which bakes it first, else `framePixels`
 * of its resolution. An impostor's `maxPixels` also sizes its bake. `maxPixels: Infinity` on the first level, unless it
 * is an impostor, draws it at any height in place of the source, so a cached level draws without fetching the source.
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

/** An impostor whose fitted atlas supplies the missing threshold. */
export function inferredImpostor(level: LodLevelRequest): level is Extract<LodLevelRequest, { type: "impostor" }> {
  return level.type === "impostor" && level.maxPixels === undefined;
}

/** Make a fresh source, including resources the loader can dispose, each time the ladder needs one. */
export type LodSource = (context: { loader: CachedLodLoader; manager: LoadingManager }) => Object3D | Promise<Object3D>;

/**
 * A .glb, .gltf or .glts asset URL, or an inline function that builds the model, and the levels derived from it. Source
 * and simplified levels load or build the source on demand; with no levels, the source is the whole ladder.
 */
export type LodRequest = ({ url: string; source?: never } | { source: LodSource; url?: never }) & { levels: readonly LodLevelRequest[] };

/** A normalized request. */
export type Ladder = ReturnType<typeof normalize>;

/**
 * `request` with its source URL resolved against `path`, which loads it, and `publicPath` of that, which its levels are
 * stored under. An inline source stands for a source in the loader's directory, or the page's without a path. A baked
 * level's low and interior URLs stay relative to the source.
 */
export function normalize(request: LodRequest, path: string, publicPath: (url: string) => string) {
  const url = request.source ? path || "./" : loaderPathURL(request.url, path);
  const levels = structuredClone(request.levels);
  levels.forEach((level, position) => {
    if (level.maxPixels !== Infinity) return;
    if (position > 0) throw new Error(`CachedLodLoader: only the first level can have maxPixels Infinity, not level ${position + 1}`);
    if (level.type === "impostor") throw new Error("CachedLodLoader: an impostor's maxPixels sizes its bake, so it cannot be Infinity");
  });
  return { url, key: publicPath(url), source: request.source, levels };
}

/** The request of ladder level `index`, which must be a derived level. */
export function derived(levels: readonly LodLevelRequest[], index: number): Derived {
  const level = levels[index - 1];
  if (!level || level.type === "empty") throw new Error(`CachedLodLoader: level ${index} is not derived`);
  return level;
}

import type { Object3D } from "three/webgpu";
import type { CacheEntry } from "vitecache";
import type { ImpostorMeshOptions } from "../impostor/mesh/index.js";
import type { BakeImpostorOptions } from "../impostor/bake/index.js";
import type { SimplifyOptions } from "../simplify/index.js";
import { ladderEntry, type LodCacheOptions } from "./cache.js";
import type { Derived } from "./level.js";
import type { AssetDependencies } from "./dependencies.js";
import { loaderPathURL, sourceRelativeURL } from "./url.js";

// What a LodLoader is asked for, normalised, and the cache entries the levels it derives are saved under.

/**
 * Whether this runs in a production server-side build (`import.meta.env.PROD` and `SSR`), which precomputes assets
 * into the deployed cache: every level is built and saved, and a level that cannot be saved fails the build.
 */
export const warmup = import.meta.env?.PROD === true && import.meta.env?.SSR === true;

/**
 * Levels derived from the source, finest first. Each derived level is built and persisted when it first loads; a
 * simplified or baked level without `maxPixels` is built with the ladder, since its default threshold is measured from
 * its deviation, and so is every level in a `vite build` warmup. An impostor's default is `framePixels` of its
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
export type LodRequest =
  | string
  | {
      url: string;
      levels?: readonly LodLevelRequest[];
      /**
       * Apply runtime effects when a level arrives, before draws compile. Does not change baked content or bounds.
       * `index` is the returned ladder's: 0 is the source, and `levels[i]` arrives as `i + 1`. Set `castShadow` and
       * `shadowSide` here: a level compiles its draws, shadow maps' included, before it arrives, so a shadow setting
       * changed later compiles mid-frame.
       */
      onLevel?: (object: Object3D, index: number) => void | Promise<void>;
    };
const DEFAULT_LEVELS: readonly LodLevelRequest[] = [{ type: "impostor" }];

/** A normalized request, with the digests of its bundled modules when its levels are cacheable. */
export type Ladder = ReturnType<typeof normalize> & { modules: Record<string, string> | undefined };

/** `request` with its URLs resolved against `path`, and every asset URL it builds from named as a dependency. */
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
  return { ...input, url, levels, urls };
}

/** The request of ladder level `index`, which must be a derived level. */
export function derived(levels: readonly LodLevelRequest[], index: number): Derived {
  const level = levels[index - 1];
  if (!level || level.type === "empty") throw new Error(`LodLoader: level ${index} is not derived`);
  return level;
}

/** The dependency name of the low or interior asset of the baked level at ladder index `level`. */
export const auxiliary = (level: number, name: "low" | "interior") => `auxiliary:${level}:${name}`;

/** Derived level `index`'s cache entry, keyed by the inputs it is built from; undefined when the ladder is not cacheable. */
export function levelEntry(ladder: Ladder, index: number, dependencies: AssetDependencies, options?: LodCacheOptions): CacheEntry | undefined {
  // Keyed by role rather than ladder position, so adding or removing another level leaves this one's entry.
  const roles = { source: "source", low: auxiliary(index, "low"), interior: auxiliary(index, "interior") };
  return entry(ladder, derived(ladder.levels, index), roles, dependencies, options);
}

/** The cache entry of the source's shape, which describes the ladder before any level is built. */
export function shapeEntry(ladder: Ladder, dependencies: AssetDependencies, options?: LodCacheOptions): CacheEntry | undefined {
  return entry(ladder, "shape", { source: "source" }, dependencies, options);
}

function entry({ modules }: Ladder, of: Derived | "shape", roles: Record<string, string>, dependencies: AssetDependencies, options?: LodCacheOptions) {
  if (!modules) return undefined;
  const pick = <T>(values: Readonly<Record<string, T>>): Record<string, T> =>
    Object.fromEntries(
      Object.entries(roles).flatMap(([role, name]) => {
        const value = values[name];
        return value === undefined ? [] : [[role, value] as const];
      }),
    );
  return ladderEntry(pick(dependencies.inputs), of, pick(modules), options);
}

/** `entry` and the bytes it holds, read: undefined when it holds none. */
export async function cached(entry: CacheEntry | undefined): Promise<{ entry: CacheEntry | undefined; bytes: Uint8Array | undefined }> {
  return { entry, bytes: await entry?.load() };
}

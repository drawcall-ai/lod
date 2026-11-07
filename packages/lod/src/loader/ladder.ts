import type { Object3D } from "three/webgpu";
import { MissingDependencyError, type CacheEntry } from "vitecache";
import type { ImpostorMeshOptions } from "../impostor/mesh/index.js";
import type { BakeImpostorOptions } from "../impostor/bake/index.js";
import type { SimplifyOptions } from "../simplify.js";
import { ladderEntry, type LodCacheOptions } from "./cache.js";
import type { Derived } from "./level.js";
import type { Provenance } from "./provenance.js";
import { loaderPathURL, sourceRelativeURL } from "./url.js";

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
export type LevelRequest =
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
      levels?: readonly LevelRequest[];
      /**
       * Apply runtime effects when a level arrives, before draws compile. Does not change baked content or bounds.
       * `index` is the returned ladder's: 0 is the source, and `levels[i]` arrives as `i + 1`.
       */
      onLevel?: (object: Object3D, index: number) => void | Promise<void>;
    };
const DEFAULT_LEVELS: readonly LevelRequest[] = [{ type: "impostor" }];

/** A normalized request, with the digests of its bundled modules when its levels are cacheable. */
export type Ladder = ReturnType<typeof normalize> & { modules: Record<string, string> | undefined };

/** `request` with its URLs resolved against `path`, and every asset URL it builds from named for provenance. */
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
export function derived(levels: readonly LevelRequest[], index: number): Derived {
  const level = levels[index - 1];
  if (!level || level.type === "empty") throw new Error(`LodLoader: level ${index} is not derived`);
  return level;
}

/** Provenance name of the low or interior asset of the baked level at ladder index `level`. */
export const auxiliary = (level: number, name: "low" | "interior") => `auxiliary:${level}:${name}`;

/** Derived level `index`'s cache entry, keyed by the inputs it is built from; undefined when the ladder is not cacheable. */
export function levelEntry(ladder: Ladder, index: number, provenance: Provenance, options?: LodCacheOptions): CacheEntry | undefined {
  // Keyed by role rather than ladder position, so adding or removing another level keeps this one's entry.
  const roles = { source: "source", low: auxiliary(index, "low"), interior: auxiliary(index, "interior") };
  return entry(ladder, derived(ladder.levels, index), roles, provenance, options);
}

/** The cache entry of the source's shape, which describes the ladder before any level is built. */
export function shapeEntry(ladder: Ladder, provenance: Provenance, options?: LodCacheOptions): CacheEntry | undefined {
  return entry(ladder, "shape", { source: "source" }, provenance, options);
}

function entry({ modules }: Ladder, of: Derived | "shape", roles: Record<string, string>, provenance: Provenance, options?: LodCacheOptions) {
  if (!modules) return undefined;
  const pick = <T>(values: Readonly<Record<string, T>>): Record<string, T> =>
    Object.fromEntries(
      Object.entries(roles).flatMap(([role, name]) => {
        const value = values[name];
        return value === undefined ? [] : [[role, value] as const];
      }),
    );
  return ladderEntry(pick(provenance.inputs), of, pick(modules), options);
}

/** `entry` and the bytes it holds, read: undefined when it holds none. */
export async function cached(entry: CacheEntry | undefined): Promise<{ entry: CacheEntry | undefined; bytes: Uint8Array | undefined }> {
  return { entry, bytes: await entry?.load() };
}

/** Save `bytes` to `entry`, read before, when what they were built from can be validated later; warn once otherwise. */
export async function save(url: string, entry: CacheEntry | undefined, bytes: Uint8Array, provenance: Provenance): Promise<void> {
  if (!entry) return warnUncached(url, "it is not a same-origin path");
  // Read now: GLTS sources keep reporting what they observe while levels are built.
  const saved = provenance.dependencies();
  if ("reason" in saved) return warnUncached(url, saved.reason);
  if (uncached.has(url)) return;
  try {
    await entry.save(bytes, { dependencies: saved.dependencies });
  } catch (error) {
    // A dependency without a backing file, such as a middleware URL or a package the app does not install, cannot be validated.
    if (!(error instanceof MissingDependencyError)) throw error;
    warnUncached(url, error.message);
  }
}

const uncached = new Set<string>();

/** Builds of `url` are served without saving from now on, after one warning naming why; a build warmup fails instead. */
function warnUncached(url: string, reason: string): void {
  if (warmup) throw new Error(`LodLoader: cannot precompute "${url}": ${reason}`);
  if (uncached.has(url)) return;
  uncached.add(url);
  console.warn(`LodLoader: "${url}" is not cached until the page reloads: ${reason}`);
}

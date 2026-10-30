import { CacheEntry, type CacheEntryOptions, type Dependencies, type JsonValue } from "vitecache";
import type { LevelRequest } from "../loader.js";
import { urlQuery } from "./url.js";

/** Persistent cache location. Generator packages are discovered from GLTS source provenance. */
export type LodCacheOptions = Pick<CacheEntryOptions, "basePath" | "root">;

const version = "lod-levels@18";

/**
 * The index of a ladder: keyed by the requested URLs, levels and bundled modules, and saved with what loading the sources
 * revealed, so vitecache rechecks those without loading the sources.
 */
export function indexEntry(
  inputs: Dependencies,
  levels: readonly LevelRequest[],
  modules: Readonly<Record<string, string>>,
  options?: LodCacheOptions,
): CacheEntry {
  // vitecache resolves URLs to file paths; keep generation parameters in the key.
  const queries: Record<string, string> = {};
  for (const [name, dependency] of Object.entries(inputs)) {
    const query = dependency.url === undefined ? "" : urlQuery(dependency.url);
    if (query) queries[name] = query;
  }
  return new CacheEntry({
    basePath: options?.basePath,
    root: options?.root,
    version,
    dependencies: {
      ...inputs,
      "lod:levels": { value: levels.map(parameters) },
      "lod:modules": { value: modules },
      "lod:queries": { value: queries },
      // Only packages the app installs resolve from its root; this package's own dependencies are covered by its version and `version` above.
      "lod:package": { package: "@drawcall/lod" },
      "lod:three": { package: "three" },
    },
  });
}

/**
 * A level payload saved apart from its index, addressed by the index's content: a valid index vouches for its payloads,
 * and rebuilds write new ones rather than replacing those a live ladder or another build still reads.
 */
export function payloadEntry(index: string, level: number, options?: LodCacheOptions): CacheEntry {
  return new CacheEntry({
    basePath: options?.basePath,
    root: options?.root,
    version,
    dependencies: { "lod:index": { value: index }, "lod:level": { value: level } },
  });
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What derives each level's content. Switch thresholds and impostor draw options apply at decode, so changing one reuses the cache. */
function parameters(level: LevelRequest): JsonValue {
  switch (level.type) {
    case "empty":
      return { type: level.type };
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

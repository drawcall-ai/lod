import { CacheEntry, type CacheEntryOptions, type Dependencies, type JsonValue } from "vitecache";
import type { Derived } from "./level.js";
import { urlQuery } from "./url.js";

/** Persistent cache location. Generator packages are discovered from GLTS source provenance. */
export type LodCacheOptions = Pick<CacheEntryOptions, "basePath" | "root">;

/**
 * What builds and lays out a cached level, and so what identifies it beside its inputs: bump it with any change to
 * the bytes a level or shape entry holds. Not this package's files, which change with every rebuild, whether a level
 * would or not.
 */
const version = "lod-level@23";

/**
 * One derived level, or the source's shape: keyed by the URLs it is built from, its request and their bundled modules,
 * and saved with what loading them revealed, so vitecache rechecks those without loading the sources. Each level has
 * its own entry, so a level is built and saved only when it is first needed; the shape's describes the ladder before
 * any level is.
 */
export function ladderEntry(inputs: Dependencies, of: Derived | "shape", modules: Readonly<Record<string, string>>, options?: LodCacheOptions): CacheEntry {
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
      "lod:level": { value: of === "shape" ? { type: of } : parameters(of) },
      "lod:modules": { value: modules },
      "lod:queries": { value: queries },
      // Only packages the app installs resolve from its root; this package's own dependencies are covered by `version` above.
      "lod:three": { package: "three" },
    },
  });
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What derives a level's content. Switch thresholds and impostor draw options apply at decode, so changing one reuses the cache. */
function parameters(level: Derived): JsonValue {
  switch (level.type) {
    case "simplify":
      // Alpha-tested cards are thinned whole since lod-level@23; keyed here so other kinds' levels stay cached.
      return { type: level.type, ratio: level.ratio ?? null, cards: "thin" };
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

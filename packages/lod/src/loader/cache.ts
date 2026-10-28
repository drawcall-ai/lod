import { CacheEntry, type CacheEntryOptions, type Dependencies, type JsonValue } from "vitecache";
import type { LevelRequest } from "../loader.js";
import type { MaterialResolver } from "./mesh.js";
import type { Kind } from "./bundle.js";

/** Cache location and additional source inputs. Dependency names beginning with lod: are reserved. */
export interface LodCacheOptions extends Pick<CacheEntryOptions, "basePath" | "root"> {
  dependencies?: Dependencies;
}

export interface Recipe {
  levels: readonly LevelRequest[];
  material?: MaterialResolver;
  type?: Exclude<Kind, "empty">;
  reference?: boolean;
}

export function entryFor(dependencies: Dependencies, recipe: Recipe, options?: LodCacheOptions, level?: number): CacheEntry {
  const inputs = { ...options?.dependencies, ...dependencies };
  if (Object.keys(inputs).some((name) => name.startsWith("lod:"))) throw new Error("LodLoader: dependency names beginning with lod: are reserved");
  // vitecache resolves URLs to file paths; keep generation parameters in the key.
  const queries: Record<string, string> = {};
  for (const [name, dependency] of Object.entries(inputs)) {
    if (dependency.url !== undefined) queries[name] = new URL(dependency.url, "https://lod.invalid").search;
  }
  return new CacheEntry({
    basePath: options?.basePath,
    root: options?.root,
    version: "lod-levels@7",
    dependencies: {
      ...inputs,
      "lod:levels": { value: recipe.levels.map(parameters) },
      "lod:role": { value: level === undefined ? "index" : `level:${level}` },
      "lod:materials": { value: recipe.material !== undefined },
      "lod:reference": { value: recipe.reference ?? false },
      "lod:type": { value: recipe.type ?? "mesh" },
      "lod:queries": { value: queries },
      "lod:package": { package: "@drawcall/lod" },
      "lod:three": { package: "three" },
    },
  });
}

function parameters(level: LevelRequest): JsonValue {
  if (level.source) return { type: level.type, maxPixels: level.maxPixels ?? null, source: "factory" };
  switch (level.type) {
    case "empty":
      return { type: level.type, maxPixels: level.maxPixels };
    case "mesh":
      return { type: level.type, maxPixels: level.maxPixels ?? null, ratio: level.ratio ?? null };
    case "baked":
      return {
        type: level.type,
        maxPixels: level.maxPixels ?? null,
        ratio: level.ratio ?? null,
        textureSize: level.textureSize ?? null,
        low: typeof level.low === "function" ? "factory" : (level.low ?? null),
        interior: typeof level.interior === "function" ? "factory" : (level.interior ?? null),
      };
    case "impostor":
      return {
        type: level.type,
        maxPixels: level.maxPixels ?? null,
        layout: level.layout ?? null,
        frames: level.frames ?? null,
        resolution: level.resolution ?? null,
        emissive: level.emissive ?? null,
        supersample: level.supersample ?? null,
        draw: {
          alphaTest: level.draw?.alphaTest ?? null,
          parallax: level.draw?.parallax ?? null,
          tolerance: level.draw?.tolerance ?? null,
          mipBias: level.draw?.mipBias ?? null,
        },
      };
  }
}

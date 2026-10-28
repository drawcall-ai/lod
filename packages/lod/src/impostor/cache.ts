import type { Object3D } from "three/webgpu";
import { CacheEntry, type CacheEntryOptions, type Dependencies } from "vitecache";
import { bakeImpostor, type BakeImpostorOptions } from "./bake/index.js";
import { decodeImpostorAsync, encodeImpostor } from "./codec.js";
import type { Impostor } from "./impostor.js";

/** Cache location; browser basePath and Node root follow vitecache's conventions. */
export type ImpostorCacheOptions = Pick<CacheEntryOptions, "basePath" | "root">;

/**
 * Read or bake an impostor with vitecache. Declare every source input as a dependency;
 * bake options and the lod/three package versions are added automatically. Dependency
 * names beginning with `lod:` are reserved. URL dependencies need the vitecache Vite
 * plugin during development and build. Cache errors reject instead of hiding stale data.
 */
export function cachedImpostor(
  source: Object3D,
  options: BakeImpostorOptions,
  dependencies: Dependencies,
  cacheOptions?: ImpostorCacheOptions,
): Promise<Impostor> {
  return cached(options, dependencies, (settings) => bakeImpostor(source, settings), cacheOptions);
}

/** Shared persistence for the public bake and the loader's source-excluding bake. */
export async function cached(
  options: BakeImpostorOptions,
  dependencies: Dependencies,
  make: (options: BakeImpostorOptions) => Promise<Impostor>,
  cacheOptions?: ImpostorCacheOptions,
): Promise<Impostor> {
  const settings = { ...options };
  if (Object.keys(dependencies).some((name) => name.startsWith("lod:"))) throw new Error("cachedImpostor: dependency names beginning with lod: are reserved");
  const entry = new CacheEntry({
    ...cacheOptions,
    version: "lod-impostor@1",
    dependencies: {
      ...dependencies,
      "lod:options": {
        value: {
          layout: settings.layout ?? null,
          frames: settings.frames ?? null,
          resolution: settings.resolution ?? null,
          maxPixels: settings.maxPixels ?? null,
          emissive: settings.emissive ?? null,
          supersample: settings.supersample ?? null,
        },
      },
      "lod:package": { package: "@drawcall/lod" },
      "lod:three": { package: "three" },
    },
  });
  const bytes = await entry.load();
  if (bytes !== undefined) return decodeImpostorAsync(bytes);
  const baked = await make(settings);
  await entry.save(encodeImpostor(baked));
  return baked;
}

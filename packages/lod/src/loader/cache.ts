import type { GLTSSource } from "@drawcall/glts";
import type { Object3D } from "three/webgpu";
import type { Dependencies } from "vitecache";
import { bake, bakeImpostor, type BakeImpostorOptions } from "../impostor/bake/index.js";
import { cached, type ImpostorCacheOptions } from "../impostor/cache.js";
import type { Impostor } from "../impostor/impostor.js";

/** Cache location and additional inputs that GLTS does not track, such as generator packages. */
export interface LodCacheOptions extends ImpostorCacheOptions {
  /** Extra vitecache dependencies. Names beginning with glts: or lod: are reserved. */
  dependencies?: Dependencies;
}

/** Loaded GLTS scenes expose their run's source even outside an active script. */
export function originOf(object: Object3D): GLTSSource | undefined {
  const source: unknown = Reflect.get(object, "source");
  if (source === undefined) return undefined;
  if (!isSource(source)) throw new Error("LodLoader: invalid GLTS source metadata");
  return source;
}

function isSource(source: unknown): source is GLTSSource {
  if (typeof source !== "object" || source === null) return false;
  const url: unknown = Reflect.get(source, "url");
  const dependencies: unknown = Reflect.get(source, "dependencyUrls");
  return typeof url === "string" && Array.isArray(dependencies) && dependencies.every((url: unknown) => typeof url === "string");
}

/** Capture dependencies when the bake starts, including files loaded since its request. */
export async function impostor(
  source: Object3D,
  options: BakeImpostorOptions,
  origin?: GLTSSource,
  excluded: readonly Object3D[] = [],
  cacheOptions?: LodCacheOptions,
): Promise<Impostor> {
  const make = (settings: BakeImpostorOptions) => (excluded.length > 0 ? bake(source, settings, excluded) : bakeImpostor(source, settings));
  if (!origin) return make(options);
  const urls = origin.dependencyUrls;
  const { dependencies = {}, ...location } = cacheOptions ?? {};
  if (Object.keys(dependencies).some((name) => name.startsWith("glts:"))) throw new Error("LodLoader: dependency names beginning with glts: are reserved");
  return cached(
    options,
    {
      ...dependencies,
      "glts:source": { url: origin.url },
      // URL resolution tracks the file; retain its query parameters as inputs too.
      "glts:query": { value: new URL(origin.url).search },
      ...Object.fromEntries(urls.map((url, index) => [`glts:dependency:${index}`, { url }])),
      "glts:dependencyQueries": { value: urls.map((url) => new URL(url).search) },
    },
    make,
    location,
  );
}

import type { GLTSSource } from "@drawcall/glts";
import * as THREE from "three/webgpu";
import { CacheEntry, type Dependencies, type JsonValue } from "vitecache";
import { unzipSync, zipSync } from "fflate";
import type { Library } from "./materials.ts";
import * as pixels from "./pixels.ts";

/** The running script's discovered code and package provenance, plus its generation parameters. */
export function assetEntry(source: GLTSSource, version: string, parameters: JsonValue): CacheEntry {
  const files = [...new Set([source.url, ...source.dependencyUrls])].sort();
  const dependencies: Dependencies = {
    ...Object.fromEntries(files.map((url, index) => [`code:${index}`, { url }])),
    ...Object.fromEntries(source.packages.map((name) => [`package:${name}`, { package: name }])),
    ...Object.fromEntries(Object.entries(source.moduleHashes).map(([url, hash]) => [`module:${url}`, { value: hash }])),
    parameters: { value: parameters },
  };
  return new CacheEntry({ version: `city-${version}`, dependencies });
}

/** Named binary data owned by the plan and procedural texture generators. */
export async function bundle(entry: CacheEntry, make: () => Promise<Record<string, Uint8Array>>): Promise<Record<string, Uint8Array>> {
  const bytes = await entry.load();
  if (bytes !== undefined) return unzipSync(bytes);
  const files = await make();
  // Entries already use their own lossless encoding. This is just a named container.
  await entry.save(zipSync(files, { level: 0 }));
  return files;
}

/** A material whose generated maps are cached as lossless pixels, independent of any geometry. */
interface PixelMaterial<M extends THREE.Material> {
  version: string;
  /** The library task and cache entry; one per material. */
  name: string;
  /** Each map's byte length (RGBA8, width × height × 4). */
  sizes: Record<string, number>;
  /** Generates the maps without `pixels`, else builds them from the cached pixels by map name. */
  make(library: Library, pixels?: Record<string, Uint8Array>): M;
  /** A generated material's maps by name. */
  maps(material: M): Record<string, THREE.Texture | null>;
}

export function pixelMaterial<M extends THREE.Material>(source: GLTSSource, library: Library, recipe: PixelMaterial<M>): Promise<THREE.Material> {
  const { version, name, sizes, make, maps } = recipe;
  return library.task(name, async () => {
    let made: M | undefined;
    const files = await bundle(assetEntry(source, version, { name }), async () => {
      made = make(library);
      const textures = maps(made);
      const encoded = await Promise.all(Object.keys(sizes).map(async (map) => [map, await pixels.encode(bytes(textures[map], `${name} ${map}`))] as const));
      return Object.fromEntries(encoded);
    });
    if (made) return made;
    const decoded = await Promise.all(Object.entries(sizes).map(async ([map, size]) => [map, await pixels.decode(file(files, map), size)] as const));
    return make(library, Object.fromEntries(decoded));
  });
}

function bytes(texture: THREE.Texture | null | undefined, label: string): Uint8Array {
  if (!(texture instanceof THREE.DataTexture)) throw new Error(`${label} is not a pixel map`);
  const data: unknown = texture.image.data;
  if (!(data instanceof Uint8Array)) throw new Error(`${label} requires byte pixels`);
  return data;
}

export function file(files: Record<string, Uint8Array>, name: string): Uint8Array {
  const bytes = files[name];
  if (!bytes) throw new Error(`Missing city asset ${name}`);
  return bytes;
}

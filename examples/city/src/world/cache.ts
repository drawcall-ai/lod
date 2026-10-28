import { CacheEntry, type Dependencies, type JsonValue } from "vitecache";
import { unzipSync, zipSync } from "fflate";
import { manifest } from "../content/materials.ts";

// Procedural assets share geometry, noise and material helpers. Tracking the whole
// content directory deliberately invalidates more than necessary when one changes.
const content = Object.fromEntries(
  Object.keys(import.meta.glob("../content/**/*.ts"))
    .sort()
    .map((path, i) => [`code:${i}`, { path: path.replace("../", "src/") }]),
);

const shared: Dependencies = {
  manifest: { path: "assets/manifest.json" },
  cache: { path: "src/world/cache.ts" },
};

/** Real fetched model inputs, including which nodes become this centred variant. */
export function model(id: string, variant: number, groups?: string[][], ratio?: number): Dependencies {
  const entry = manifest().models[id];
  if (!entry) throw new Error(`No model dependency for ${id}`);
  const nodes = (groups ?? entry.variants.map((name) => [name]))[variant];
  if (!nodes) throw new Error(`No variant ${variant} in model ${id}`);
  return {
    ...shared,
    model: { path: `assets/${entry.file}` },
    selection: { value: { nodes, ratio: ratio ?? 1 } },
    ...(ratio === undefined ? {} : { simplifier: { package: "meshoptimizer" } }),
    models: { path: "src/content/models.ts" },
    foliage: { path: "src/content/foliage.ts" },
    materials: { path: "src/content/materials.ts" },
  };
}

/** Dependencies available before a procedural asset has been constructed. */
export function proceduralFiles(generator: string, parameters: JsonValue, textureIds: readonly string[]): Dependencies {
  const files = new Set<string>();
  for (const id of textureIds) {
    const maps = manifest().textures[id];
    if (!maps) throw new Error(`No texture set ${id} in the asset manifest`);
    for (const path of [maps.diff, maps.nor, maps.arm]) files.add(`assets/${path}`);
  }
  return {
    ...shared,
    ...content,
    ...Object.fromEntries([...files].sort().map((path, i) => [`image:${i}`, { path }])),
    generator: { path: generator },
    parameters: { value: parameters },
    lod: { package: "@drawcall/lod" },
    three: { package: "three" },
  };
}

/** Plain data shared outside LOD levels: the town plan and house texture arrays. */
export async function bundle(
  version: string,
  dependencies: Dependencies,
  make: () => Promise<Record<string, Uint8Array>>,
): Promise<Record<string, Uint8Array>> {
  const entry = new CacheEntry({ version: `city-${version}`, dependencies });
  const bytes = await entry.load();
  if (bytes !== undefined) return unzipSync(bytes);
  const files = await make();
  // Entries already use their own lossless encoding. This is just a named container.
  await entry.save(zipSync(files, { level: 0 }));
  return files;
}

export function file(files: Record<string, Uint8Array>, name: string): Uint8Array {
  const bytes = files[name];
  if (!bytes) throw new Error(`Missing city asset ${name}`);
  return bytes;
}

/** Compact large parameter lists so vitecache's dependency headers remain bounded. */
export async function parameterKey(value: JsonValue): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

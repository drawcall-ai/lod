import { Loader, LoadingManager, Mesh, RGBAFormat, Scene, type Object3D, type Renderer } from "three/webgpu";
import { beforeEach, vi } from "vitest";
import type { CacheEntryOptions, Dependencies, SaveOptions } from "vitecache";
import { boundingBox } from "../../src/source/detail.js";
import type { Impostor } from "../../src/impostor/impostor.js";

export const cache = {
  files: new Map<string, { bytes: Uint8Array; hashes: string; dependencies: Dependencies }>(),
  versions: new Map<string, string>(),
  /** Locators with no backing file, which vitecache refuses to save as dependencies. */
  missing: new Set<string>(),
  /** Whether each load() hit. */
  loaded: new Array<boolean>(),
  /** Every save() call, including those that throw. */
  attempts: 0,
  saved: new Array<{ options: CacheEntryOptions; dependencies: Dependencies }>(),
};

/** Current state of file and package dependencies: `cache.versions` overrides, keyed by locator. */
function hashes(dependencies: Dependencies = {}): string {
  return JSON.stringify(
    Object.entries(dependencies)
      .filter(([, dependency]) => dependency.value === undefined)
      .map(([name, dependency]) => {
        const locator = dependency.package ?? dependency.url ?? dependency.path ?? "";
        return [name, cache.versions.get(locator) ?? locator];
      }),
  );
}

/** vitecache resolves URL dependencies through the project's dev server, so it rejects other origins. */
function local(dependencies: Dependencies = {}): void {
  for (const { url } of Object.values(dependencies)) {
    if (url !== undefined && new URL(url, location.href).origin !== location.origin)
      throw new Error("URL dependencies must be served by the same Vite project origin.");
  }
}

export class MissingDependencyError extends Error {}

function absent(dependencies: Dependencies = {}) {
  return Object.values(dependencies).find(({ url, path, package: name }) => cache.missing.has(url ?? path ?? name ?? ""));
}

/**
 * Mirrors vitecache: load() notes a key-dependency baseline that save() requires unchanged unless the key holds only values,
 * and saved dependencies validate later loads.
 */
export class CacheEntry {
  private readonly key: string;
  private baseline: string | undefined;
  constructor(private readonly options: CacheEntryOptions) {
    this.key = JSON.stringify(options);
  }
  async load() {
    local(this.options.dependencies);
    this.baseline = hashes(this.options.dependencies);
    const stored = cache.files.get(this.key);
    const valid = stored && !absent(this.options.dependencies) && stored.hashes === this.baseline + hashes(stored.dependencies);
    const bytes = valid ? stored.bytes : undefined;
    cache.loaded.push(bytes !== undefined);
    return bytes;
  }
  async save(bytes: Uint8Array, { dependencies = {} }: SaveOptions = {}) {
    cache.attempts++;
    local(dependencies);
    const current = hashes(this.options.dependencies);
    if (current !== "[]" && current !== this.baseline) throw new Error("dependencies changed since load()");
    if (absent(this.options.dependencies)) throw new MissingDependencyError("Cannot save a cache entry with missing file or package dependencies.");
    const missing = absent(dependencies);
    if (missing) throw new MissingDependencyError(`Missing saved dependency ${JSON.stringify(missing)}`);
    cache.saved.push({ options: this.options, dependencies });
    cache.files.set(this.key, { bytes, hashes: current + hashes(dependencies), dependencies });
  }
}

/** A minimal impostor with the box a real bake of `source` has. */
export function impostorOf(source: Object3D): Impostor {
  const box = boundingBox(source);
  return {
    version: 4,
    layout: "full",
    frames: 2,
    size: 8,
    box: [...box.min.toArray(), ...box.max.toArray()],
    halfSize: 2,
    maps: ["base", "normalDepth", "orm"],
    layers: Array.from({ length: 3 }, () => ({ format: RGBAFormat, mipmaps: [8, 4, 2].map((size) => new Uint8Array(size * size * 4)) })),
  };
}

export const bakeImpostor = vi.fn<(source: Object3D, renderer: Renderer) => Promise<Impostor>>(async (source) => impostorOf(source));

beforeEach(() => {
  cache.loaded.length = cache.saved.length = cache.attempts = 0;
  cache.files.clear();
  cache.versions.clear();
  cache.missing.clear();
  bakeImpostor.mockReset().mockImplementation(async (source) => impostorOf(source));
});

export function sourceFixture(make: (url: string) => unknown, extension = /\.(glts|gltf|glb)$/) {
  const manager = new LoadingManager();
  const handler = new Loader<unknown>();
  const load = vi.fn(async (url: string) => make(url));
  handler.loadAsync = load;
  manager.addHandler(extension, handler);
  return { manager, load, handler };
}

/** A scene holding `objects`, as GLTSLoader loads it: with its `source` provenance and a `dispose` that frees what it holds. */
export function gltsScene(source: unknown, ...objects: Object3D[]): Scene {
  // Object3D.add with no object logs an error.
  const scene = new Scene();
  for (const object of objects) scene.add(object);
  const dispose = () =>
    scene.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      node.geometry.dispose();
      for (const material of [node.material].flat()) material.dispose();
    });
  return Object.assign(scene, { source, dispose });
}

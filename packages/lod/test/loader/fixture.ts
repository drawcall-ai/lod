import { Loader, LoadingManager, Mesh, RGBAFormat, Scene, type Object3D, type Renderer } from "three/webgpu";
import { beforeEach, vi } from "vitest";
import type { CacheEntryOptions, Input, SaveOptions } from "vitecache";
import { boundingBox } from "../../src/source/detail.js";
import type { Impostor } from "../../src/impostor/impostor.js";

export const cache = {
  files: new Map<string, Uint8Array>(),
  /** Whether each load() hit. */
  loaded: new Array<boolean>(),
  saved: new Array<{ options: CacheEntryOptions; dependencies: readonly Input[] }>(),
};

/** Mirrors vitecache as Node runs it: an entry per version and dependencies, which save() writes after a load(). */
export class CacheEntry {
  private readonly key: string;
  private loaded = false;
  constructor(private readonly options: CacheEntryOptions) {
    this.key = JSON.stringify([options.version, options.dependencies]);
  }
  async load() {
    this.loaded = true;
    const bytes = cache.files.get(this.key);
    cache.loaded.push(bytes !== undefined);
    return bytes;
  }
  async save(bytes: Uint8Array, { dependencies = [] }: SaveOptions = {}) {
    if (!this.loaded) throw new Error("Call CacheEntry.load() before computing the result to save.");
    cache.saved.push({ options: this.options, dependencies });
    cache.files.set(this.key, bytes);
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
  cache.loaded.length = cache.saved.length = 0;
  cache.files.clear();
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

/** A scene holding `objects`, as GLTSLoader loads it: with a `dispose` of its own that frees what it holds. */
export function gltsScene(...objects: Object3D[]): Scene {
  // Object3D.add with no object logs an error.
  const scene = new Scene();
  for (const object of objects) scene.add(object);
  const dispose = () =>
    scene.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      node.geometry.dispose();
      for (const material of [node.material].flat()) material.dispose();
    });
  return Object.assign(scene, { source: {}, dispose });
}

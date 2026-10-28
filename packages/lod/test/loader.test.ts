import {
  BackSide,
  BoxGeometry,
  DataTexture,
  Group,
  Loader,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  SphereGeometry,
  type Material,
} from "three/webgpu";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheEntryOptions } from "vitecache";
import { LodLoader, type LodRequest } from "../src/loader.js";
import { LazyLevel } from "../src/lazy.js";
import { bakeImpostor } from "../src/impostor/bake/index.js";
import type { Impostor } from "../src/impostor/impostor.js";
import { InteriorMaterial } from "../src/baked/interior/material.js";
import { house, interior, low } from "./house.js";

const cache = vi.hoisted(
  (): {
    entries: CacheEntryOptions[];
    files: Map<string, Uint8Array>;
    loaded: string[];
    saved: Array<{ role: string; bytes: Uint8Array }>;
  } => ({ entries: [], files: new Map(), loaded: [], saved: [] }),
);
vi.mock("vitecache", () => ({
  CacheEntry: class {
    private readonly key: string;
    private readonly role: string;
    constructor(options: CacheEntryOptions) {
      cache.entries.push(options);
      this.key = JSON.stringify(options);
      const role = options.dependencies?.["lod:role"]?.value;
      if (typeof role !== "string") throw new Error("Expected a cache role");
      this.role = role;
    }
    async load() {
      cache.loaded.push(this.role);
      return cache.files.get(this.key);
    }
    async save(bytes: Uint8Array) {
      cache.saved.push({ role: this.role, bytes });
      cache.files.set(this.key, bytes);
    }
  },
}));
vi.mock("../src/impostor/bake/index.js", async (original) => {
  const module = await original<typeof import("../src/impostor/bake/index.js")>();
  return { ...module, bakeImpostor: vi.fn(module.bakeImpostor) };
});

const baked: Impostor = {
  version: 3,
  layout: "full",
  frames: 2,
  size: 2,
  box: [-1, -1, -1, 1, 1, 1],
  halfSize: 2,
  maps: ["base", "normalDepth", "orm"],
  layers: Array.from({ length: 3 }, () => [new Uint8Array(16)]),
};
const tree = (material = new MeshStandardMaterial()) => new Group().add(new Mesh(new SphereGeometry(1, 12, 8), material));

beforeEach(() => {
  cache.entries.length = cache.saved.length = cache.loaded.length = 0;
  cache.files.clear();
  vi.mocked(bakeImpostor).mockReset().mockResolvedValue(baked);
});

describe("LodLoader", () => {
  it("fails a missing lazy cache payload visibly without regenerating its source", async () => {
    const material = new MeshStandardMaterial({ name: "surface" });
    const factory = vi.fn(async () => tree(material));
    const request: LodRequest = {
      source: factory,
      key: { fixture: { value: "missing" } },
      material: (name) => (name === "surface" ? material : undefined),
    };
    const loader = new LodLoader();
    const cold = await loader.loadAsync(request);
    cold.dispose();
    for (const [key] of cache.files) if (key.includes('"value":"level:0"')) cache.files.delete(key);
    const warm = await loader.loadAsync(request);
    const source = warm.levels[0]?.object;
    if (!(source instanceof LazyLevel)) throw new Error("Expected lazy source");
    await expect(source.load()).rejects.toThrow("cached level 0 is missing");
    expect(factory).toHaveBeenCalledOnce();
    expect(cache.saved.map((entry) => entry.role)).toEqual(["level:0", "index"]);
    warm.dispose();
  });

  it("loads original textures only on mesh demand and shares them with cached simplified levels", async () => {
    const manager = new LoadingManager();
    const handler = new Loader<{ scene: Group }>();
    const load = vi.fn(async () => {
      const map = new DataTexture(new Uint8Array([86, 98, 43, 0, 86, 98, 43, 255]), 2, 1);
      map.needsUpdate = true;
      const material = new MeshStandardMaterial({ map, alphaTest: 0.5 });
      return {
        scene: new Group().add(new Mesh(new SphereGeometry(1, 12, 8), material), new Mesh(new SphereGeometry(1, 12, 8), material.clone()).translateX(2)),
      };
    });
    handler.loadAsync = load;
    manager.addHandler(/\.glb(?:\?|$)/, handler);
    const loader = new LodLoader(manager).setPath("/models/");
    const request: LodRequest = {
      url: "tree.glb?seed=2",
      levels: [{ type: "mesh", ratio: 0.5, maxPixels: 100 }, { type: "impostor" }],
      restore: (object, index) => {
        if (index === 2) return;
        const first = object.children[0];
        if (!(first instanceof Mesh)) throw new Error("Expected mesh source");
        object.traverse((node) => {
          if (node instanceof Mesh) node.material = first.material;
        });
      },
    };
    const cold = await loader.loadAsync(request);
    expect(load).toHaveBeenCalledExactlyOnceWith("/models/tree.glb?seed=2");
    expect(cache.entries[0]?.dependencies?.["lod:queries"]).toEqual({ value: { source: "?seed=2" } });
    expect(cache.saved.map(({ role }) => role)).toEqual(["level:1", "index"]);
    cold.dispose();
    const warm = await loader.loadAsync(request);
    try {
      expect(load).toHaveBeenCalledOnce();
      const source = warm.levels[0]?.object;
      const detail = warm.levels[1]?.object;
      if (!(source instanceof LazyLevel) || !(detail instanceof LazyLevel)) throw new Error("Expected deferred mesh levels");
      const simplified = await detail.load();
      expect(load).toHaveBeenCalledTimes(2);
      const original = await source.load();
      expect(load).toHaveBeenCalledTimes(2);
      expect(original.children).toHaveLength(2);
      expect(simplified.children).toHaveLength(2);
      for (let index = 0; index < 2; index++) {
        const sourceMesh = original.children[index];
        const detailMesh = simplified.children[index];
        if (!(sourceMesh instanceof Mesh) || !(detailMesh instanceof Mesh) || !(sourceMesh.material instanceof MeshStandardMaterial))
          throw new Error("Expected original and simplified meshes");
        expect(detailMesh.material).toBe(sourceMesh.material);
        if (!(sourceMesh.material.map instanceof DataTexture)) throw new Error("Expected original texture");
        expect(sourceMesh.material.map.image.data).toEqual(new Uint8Array([86, 98, 43, 0, 86, 98, 43, 255]));
      }
    } finally {
      warm.dispose();
    }
  });

  it("persists baked interiors separately from source detail and keeps both on warm loads", async () => {
    const source = house();
    const inside = interior();
    const materials = new Map<string, Material>();
    for (const object of [source, inside])
      object.traverse((node) => {
        if (!(node instanceof Mesh)) return;
        for (const material of [node.material].flat()) {
          if (!material.name) material.name = `surface ${materials.size}`;
          materials.set(material.name, material);
        }
      });
    const factory = vi.fn(async () => source);
    const rooms = vi.fn(async () => inside);
    const shell = vi.fn(async () => low());
    const request: LodRequest = {
      source: factory,
      key: { building: { value: "one-room" } },
      material: (name) => materials.get(name),
      levels: [{ type: "baked", low: shell, interior: rooms, textureSize: 32, maxPixels: 100 }],
    };
    const loader = new LodLoader();
    const cold = await loader.loadAsync(request);
    const count = cold.levels[0]?.object.children.length;
    cold.dispose();
    const warm = await loader.loadAsync(request);
    expect(factory).toHaveBeenCalledOnce();
    expect(rooms).toHaveBeenCalledOnce();
    expect(shell).toHaveBeenCalledOnce();
    expect(cache.saved).toHaveLength(2);
    const baked = warm.levels[1]?.object;
    if (!(baked instanceof Mesh) || !(baked.material instanceof InteriorMaterial)) throw new Error("Expected restored baked windows");
    expect(baked.material.rooms?.boxes).toHaveLength(1);
    const lazy = warm.levels[0]?.object;
    if (!(lazy instanceof LazyLevel)) throw new Error("Expected deferred source rooms");
    const restored = await lazy.load();
    expect(restored.children).toHaveLength(count ?? 0);
    let inward = 0;
    restored.traverse((node) => {
      if (node instanceof Mesh) for (const material of [node.material].flat()) if (material.side === BackSide) inward++;
    });
    expect(inward).toBe(6);
    warm.dispose();
  }, 120_000);

  it("requires procedural material references and caches authored mesh factories", async () => {
    const source = vi.fn(async () => new Mesh(new BoxGeometry(), new MeshStandardMaterial({ name: "surface" })));
    const detail = vi.fn(async () => new Mesh(new BoxGeometry(), new MeshStandardMaterial({ name: "surface" })));
    const request: LodRequest = { source, key: { fixture: { value: "authored" } }, levels: [{ type: "mesh", source: detail, maxPixels: 100 }] };
    const loader = new LodLoader();
    await expect(loader.loadAsync(request)).rejects.toThrow(/material/i);
    const material = new MeshStandardNodeMaterial({ name: "surface" });
    const resolved: LodRequest = { ...request, material: (name) => (name === "surface" ? material : undefined) };
    const cold = await loader.loadAsync(resolved);
    expect(source).toHaveBeenCalledTimes(2);
    expect(detail).toHaveBeenCalledTimes(2);
    const warm = await loader.loadAsync(resolved);
    expect(source).toHaveBeenCalledTimes(2);
    expect(detail).toHaveBeenCalledTimes(2);
    const lazy = warm.levels[0]?.object;
    if (!(lazy instanceof LazyLevel)) throw new Error("Expected deferred source");
    const mesh = await lazy.load();
    if (!(mesh instanceof Mesh)) throw new Error("Expected source mesh");
    expect(mesh.material).toBe(material);
    warm.dispose();
    cold.dispose();
  });
});

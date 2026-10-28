import { BoxGeometry, BufferGeometry, DataTexture, Group, Loader, LoadingManager, Mesh, MeshStandardMaterial, SphereGeometry } from "three/webgpu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GLTSSource } from "@drawcall/glts";
import type { CacheEntryOptions } from "vitecache";
import { InstancedLod } from "../src/instanced/index.js";
import { args } from "../src/instanced/args.js";
import { LodLoader } from "../src/loader.js";
import { LazyImpostor } from "../src/lazy.js";
import { bakeImpostor } from "../src/impostor/bake/index.js";
import { sourceForBake } from "../src/impostor/bake/source.js";
import { cachedImpostor } from "../src/impostor/cache.js";
import { encodeImpostor } from "../src/impostor/codec.js";
import type { Impostor } from "../src/impostor/impostor.js";
import { isImpostorMesh } from "../src/three.js";
import { house, interior, low } from "./house.js";

const context = vi.hoisted((): { source?: GLTSSource } => ({}));
const cache = vi.hoisted((): { entries: CacheEntryOptions[]; bytes?: Uint8Array; saved: Uint8Array[]; error?: Error; pending?: Promise<void> } => ({
  entries: [],
  saved: [],
}));
vi.mock("@drawcall/glts", () => ({
  getGLTSSource() {
    if (!context.source) throw new Error("No GLTS execution is active");
    return context.source;
  },
}));
vi.mock("vitecache", () => ({
  CacheEntry: class {
    constructor(options: CacheEntryOptions) {
      cache.entries.push(options);
    }
    async load() {
      await cache.pending;
      if (cache.error) throw cache.error;
      return cache.bytes;
    }
    async save(bytes: Uint8Array) {
      cache.saved.push(bytes);
    }
  },
}));
vi.mock("../src/impostor/bake/index.js", async (original) => {
  const module = await original<typeof import("../src/impostor/bake/index.js")>();
  return { ...module, bakeImpostor: vi.fn(module.bakeImpostor) };
});

beforeEach(() => {
  cache.entries.length = cache.saved.length = 0;
  delete cache.bytes;
  delete cache.error;
  delete cache.pending;
  vi.mocked(bakeImpostor).mockClear();
});
afterEach(() => delete context.source);

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

const tree = () => new Group().add(new Mesh(new SphereGeometry(1, 32, 16), new MeshStandardMaterial()));

/** A manager whose handler for .glb answers with a glTF-like result. */
function managerWith(scene = tree()) {
  const manager = new LoadingManager();
  const handler = new Loader<{ scene: Group }>();
  const loads: string[] = [];
  handler.loadAsync = async (url) => (loads.push(url), { scene });
  manager.addHandler(/\.glb$/, handler);
  return { manager, loads, scene };
}

// Eager bake cases need time on software adapters; source/cache cases also run in Node.
describe("LodLoader", { timeout: 120_000 }, () => {
  it("snapshots GLTS cache bake settings before an asynchronous lookup", async () => {
    let release: () => void = () => {
      throw new Error("Pending cache was not initialized");
    };
    cache.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const options = { frames: 2, resolution: 4, maxPixels: 80 };
    vi.mocked(bakeImpostor).mockResolvedValueOnce(baked);
    const pending = cachedImpostor(tree(), options, { scene: { value: "fixture" } }, { basePath: "/app/cache/", root: "/project" });
    options.resolution = 64;
    release();
    await pending;
    expect(cache.entries[0]).toMatchObject({ basePath: "/app/cache/", root: "/project" });
    expect(cache.entries[0]?.dependencies?.["lod:options"]).toMatchObject({ value: { resolution: 4 } });
    expect(bakeImpostor).toHaveBeenCalledWith(expect.any(Group), { frames: 2, resolution: 4, maxPixels: 80 });
  });

  it("excludes GLTS loader interiors before cloning and restores the source even when cloning fails", () => {
    const source = tree(),
      rooms = tree();
    source.add(rooms);
    const children = source.children,
      contents = children.slice();
    const excludedClone = vi.spyOn(rooms, "clone").mockImplementation(() => {
      throw new Error("Excluded rooms must not clone");
    });
    const snapshot = sourceForBake(source, [rooms]);
    expect(snapshot.children).toHaveLength(1);
    expect(excludedClone).not.toHaveBeenCalled();
    expect(source.children).toBe(children);
    expect(source.children).toEqual(contents);
    expect(rooms.parent).toBe(source);
    const failedClone = vi.spyOn(source, "clone").mockImplementation(() => {
      throw new Error("clone failed");
    });
    expect(() => sourceForBake(source, [rooms])).toThrow("clone failed");
    expect(source.children).toBe(children);
    expect(source.children).toEqual(contents);
    expect(rooms.parent).toBe(source);
    failedClone.mockRestore();
    excludedClone.mockRestore();
  });

  it("loads through the manager's handler: the source, then by default an impostor", async () => {
    const { manager, loads, scene } = managerWith();
    const lod = await new LodLoader(manager).setPath("/models/").loadAsync("tree.glb");
    expect(loads).toEqual(["/models/tree.glb"]);
    expect(lod.levels.map((level) => level.object === scene || isImpostorMesh(level.object))).toEqual([true, true]);
  });

  it("builds the requested levels, the source as level 0, and sets the maxPixels requested", async () => {
    const { manager, scene } = managerWith();
    const request = {
      url: "tree.glb",
      levels: [
        { type: "simplified", ratio: 0.2, maxPixels: 300 },
        { type: "simplified", ratio: 0.1 },
      ],
    } as const;
    const lod = await new LodLoader(manager).loadAsync(request);
    expect(lod.levels[0]?.object).toBe(scene);
    expect(lod.levels[1]?.maxPixels).toBe(300);
    expect(lod.levels[2]?.maxPixels).toBeLessThan(300);
  });

  it("loads and parses instances as an InstancedLod of the same levels", async () => {
    const { manager } = managerWith();
    const loader = new LodLoader(manager);
    const loaded = await loader.loadInstancesAsync({ url: "tree.glb", levels: [{ type: "simplified", ratio: 0.2, maxPixels: 300 }] }, 5);
    context.source = { url: "https://models.test/tree.glts", dependencyUrls: [] };
    const parsed = await loader.parseInstancesAsync(tree(), 3, [{ type: "simplified", ratio: 0.2, maxPixels: 300 }]);
    for (const [lod, count] of [
      [loaded, 5],
      [parsed, 3],
    ] as const) {
      expect(lod).toBeInstanceOf(InstancedLod);
      expect(lod.count).toBe(count);
      expect(lod.levels.map((level) => level.maxPixels)).toEqual([Infinity, 300]);
    }
  });

  it("requires GLTS for object inputs and parse wrappers, without disposing caller-owned objects", async () => {
    const source = tree(),
      loader = new LodLoader();
    const disposed = vi.fn();
    source.traverse((node) => node instanceof Mesh && node.geometry.addEventListener("dispose", disposed));
    await expect(loader.loadAsync(source)).rejects.toThrow("No GLTS execution");
    await expect(loader.parseAsync(source, [])).rejects.toThrow("No GLTS execution");
    await expect(loader.parseInstancesAsync(source, 2, [])).rejects.toThrow("No GLTS execution");
    expect(disposed).not.toHaveBeenCalled();

    context.source = { url: "https://models.test/redirected/tree.glts", dependencyUrls: [] };
    const pending = loader.loadAsync({ source, levels: [] });
    delete context.source;
    expect((await pending).levels[0]?.object).toBe(source);
  });

  it("resolves object GLTS auxiliaries against the script URL and leaves failed input owned by its caller", async () => {
    const source = tree(),
      manager = new LoadingManager(),
      handler = new Loader();
    const loads: string[] = [];
    handler.loadAsync = async (url) => {
      loads.push(url);
      throw new Error("missing low");
    };
    manager.addHandler(/\.glts$/, handler);
    context.source = { url: "https://models.test/redirected/tree.glts", dependencyUrls: [] };
    await expect(new LodLoader(manager).setPath("/ignored/").loadAsync({ source, levels: [{ type: "baked", low: "low.glts" }] })).rejects.toThrow(
      "missing low",
    );
    expect(loads).toEqual(["https://models.test/redirected/low.glts"]);
    expect(source.parent).toBeNull();
  });

  it("caches complete GLTS assets with source files and the actual bake options", async () => {
    const source = tree(),
      loader = new LodLoader();
    context.source = {
      url: "https://models.test/tree.glts?seed=2",
      dependencyUrls: ["https://models.test/bark.png?variant=2", "https://models.test/helper.ts?shape=oak"],
    };
    const request = { source, levels: [{ type: "impostor", frames: 2, resolution: 4, maxPixels: 80 }] } as const;
    vi.mocked(bakeImpostor).mockResolvedValueOnce(baked);
    const pending = loader.loadAsync(request);
    delete context.source;
    await pending;
    expect(bakeImpostor).toHaveBeenCalledWith(source, { frames: 2, resolution: 4, maxPixels: 80 });
    expect(cache.entries[0]?.dependencies).toMatchObject({
      "glts:source": { url: "https://models.test/tree.glts?seed=2" },
      "glts:query": { value: "?seed=2" },
      "glts:dependency:0": { url: "https://models.test/bark.png?variant=2" },
      "glts:dependency:1": { url: "https://models.test/helper.ts?shape=oak" },
      "glts:dependencyQueries": { value: ["?variant=2", "?shape=oak"] },
      "lod:options": { value: { frames: 2, resolution: 4, maxPixels: 80 } },
      "lod:package": { package: "@drawcall/lod" },
      "lod:three": { package: "three" },
    });
    expect(cache.saved).toHaveLength(1);
    expect(cache.saved[0]).toEqual(encodeImpostor(baked));

    context.source = { url: "https://models.test/tree.glts?seed=2", dependencyUrls: [] };
    cache.bytes = encodeImpostor(baked);
    await loader.loadAsync(request);
    expect(bakeImpostor).toHaveBeenCalledTimes(1);
    expect(cache.saved).toHaveLength(1);
    cache.error = new Error("dependency validation failed");
    await expect(loader.loadAsync(request)).rejects.toThrow("dependency validation failed");
    expect(bakeImpostor).toHaveBeenCalledTimes(1);
  });

  it("uses a loaded GLTS scene's provenance without requiring an active script", async () => {
    const { manager, scene } = managerWith();
    Object.assign(scene, { source: { url: "https://models.test/redirected/tree.glts", dependencyUrls: ["https://models.test/helper.ts?shape=oak"] } });
    cache.bytes = encodeImpostor(baked);
    await new LodLoader(manager).loadAsync("tree.glb");
    expect(cache.entries[0]?.dependencies).toMatchObject({
      "glts:source": { url: "https://models.test/redirected/tree.glts" },
      "glts:query": { value: "" },
      "glts:dependency:0": { url: "https://models.test/helper.ts?shape=oak" },
    });
    expect(bakeImpostor).not.toHaveBeenCalled();
  });

  it("defers a lazy GLTS impostor and reads retained dependencies when its factory runs", async () => {
    const dependencies: string[] = [];
    context.source = {
      url: "https://models.test/tree.glts",
      get dependencyUrls() {
        return dependencies.slice();
      },
    };
    const source = tree(),
      loader = new LodLoader(undefined, { basePath: "/app/cache/", dependencies: { generator: { package: "house-generator" } } });
    await expect(loader.loadAsync({ source, levels: [{ type: "impostor", lazy: true }] })).rejects.toThrow("explicit positive maxPixels");
    const lod = await loader.loadAsync({ source, levels: [{ type: "impostor", lazy: true, maxPixels: 80, frames: 2, resolution: 4 }] });
    const lazy = lod.levels[1]?.object;
    if (!(lazy instanceof LazyImpostor)) throw new Error("Expected a lazy level");
    expect(lazy.status).toBe("idle");
    expect(cache.entries).toHaveLength(0);
    expect(bakeImpostor).not.toHaveBeenCalled();
    dependencies.push("https://models.test/late-helper.ts");
    delete context.source;
    cache.bytes = encodeImpostor(baked);
    await lazy.load();
    expect(lazy.status).toBe("ready");
    expect(cache.entries[0]?.dependencies?.["glts:dependency:0"]).toEqual({ url: "https://models.test/late-helper.ts" });
    expect(cache.entries[0]?.basePath).toBe("/app/cache/");
    expect(cache.entries[0]?.dependencies?.generator).toEqual({ package: "house-generator" });
    expect(bakeImpostor).not.toHaveBeenCalled();
    lod.dispose();
  });

  it("loads a baked level's low mesh through the manager, relative to the model", async () => {
    const { manager, loads } = managerWith();
    const low = new Group().add(new Mesh(new BoxGeometry(2, 2, 2)));
    const handler = new Loader<{ scene: Group }>();
    handler.loadAsync = async (url) => (loads.push(url), { scene: low });
    manager.addHandler(/\.glts$/, handler);
    const lod = await new LodLoader(manager)
      .setPath("/models/")
      .loadAsync({ url: "tree.glb", levels: [{ type: "baked", low: "tree-low.glts", textureSize: 32 }] });
    expect(loads).toEqual(["/models/tree.glb", "/models/tree-low.glts"]);
    expect(lod.levels[1]?.maxPixels).toBeGreaterThan(0);
  });

  it("loads a baked level's interior relative to the model, and adds it to the model once every level is built", async () => {
    const { manager, loads, scene } = managerWith(house());
    const rooms = interior();
    const handler = new Loader<{ scene: Group }>();
    handler.loadAsync = async (url) => (loads.push(url), { scene: url.endsWith("rooms.glts") ? rooms : new Group().add(low()) });
    manager.addHandler(/\.glts$/, handler);
    const levels = [
      { type: "baked", low: "house-low.glts", interior: "rooms.glts", textureSize: 32, maxPixels: 100 },
      { type: "impostor", lazy: true, maxPixels: 20, resolution: 4, frames: 2, supersample: 1 },
    ] as const;
    const lod = await new LodLoader(manager).setPath("/models/").loadAsync({ url: "house.glb", levels });
    expect(loads).toEqual(["/models/house.glb", "/models/house-low.glts", "/models/rooms.glts"]);
    expect(rooms.parent).toBe(scene);
    expect(lod.levels).toHaveLength(3);
    const lazy = lod.levels[2]?.object;
    if (!(lazy instanceof LazyImpostor)) throw new Error("Expected a deferred impostor");
    const children = scene.children;
    const roomClone = vi.spyOn(rooms, "clone");
    await lazy.load();
    expect(roomClone).not.toHaveBeenCalled();
    roomClone.mockRestore();
    expect(scene.children).toBe(children);
    expect(rooms.parent).toBe(scene);
    const twice = [levels[0], { ...levels[0], textureSize: 16 }];
    await expect(new LodLoader(manager).loadAsync({ url: "house.glb", levels: twice })).rejects.toThrow(/one baked level/);
  });

  it("fails at load on maxPixels that leave no room for the fades, and frees what it built", async () => {
    const { manager, scene } = managerWith();
    let disposed = 0;
    scene.traverse((node) => node instanceof Mesh && node.geometry.addEventListener("dispose", () => disposed++));
    const request = {
      url: "a.glb",
      levels: [
        { type: "simplified", maxPixels: 100 },
        { type: "simplified", ratio: 0.2, maxPixels: 95 },
      ],
    } as const;
    await expect(new LodLoader(manager).loadAsync(request)).rejects.toThrow(/level 2 has maxPixels 95, but at most 90/);
    expect(disposed).toBe(1);
  });

  it("rejects invalid instance thresholds before allocating a crowd or changing its caller-owned source", async () => {
    context.source = { url: "https://models.test/tree.glts", dependencyUrls: [] };
    const source = tree();
    const mesh = source.children[0];
    if (!(mesh instanceof Mesh)) throw new Error("Expected a source mesh");
    const material = mesh.material;
    if (!(material instanceof MeshStandardMaterial)) throw new Error("Expected a standard source material");
    material.map = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const hidden = new Mesh(new BoxGeometry(), material);
    hidden.visible = false;
    source.add(hidden);
    const disposed = vi.fn();
    mesh.geometry.addEventListener("dispose", disposed);
    hidden.geometry.addEventListener("dispose", disposed);
    material.addEventListener("dispose", disposed);
    material.map.addEventListener("dispose", disposed);
    const allocated = vi.spyOn(args, "take");
    const released = vi.spyOn(BufferGeometry.prototype, "dispose");
    try {
      await expect(
        new LodLoader().loadInstancesAsync(
          {
            source,
            levels: [
              { type: "simplified", maxPixels: 100 },
              { type: "simplified", ratio: 0.2, maxPixels: 95 },
            ],
          },
          3,
        ),
      ).rejects.toThrow(/level 2 has maxPixels 95, but at most 90/);
      expect(allocated).not.toHaveBeenCalled();
      expect(released).toHaveBeenCalled();
      expect(disposed).not.toHaveBeenCalled();
      expect(mesh.material).toBe(material);
      expect(source.parent).toBeNull();
    } finally {
      allocated.mockRestore();
      released.mockRestore();
    }
  });

  it("reports progress through the manager and fails visibly", async () => {
    const { manager } = managerWith();
    const done = vi.fn();
    const failed = vi.fn();
    manager.onLoad = done;
    manager.onError = failed;
    const loader = new LodLoader(manager);
    await loader.loadAsync({ url: "a.glb", levels: [] });
    expect(done).toHaveBeenCalledTimes(1);
    await expect(loader.loadAsync("model.obj")).rejects.toThrow(/expected a .glb, .gltf or .glts/);
    expect(failed).toHaveBeenCalledWith("model.obj");
    await expect(loader.loadAsync("model.glts")).rejects.toThrow(/register a GLTSLoader/);
    const onError = vi.fn();
    await new Promise<void>((resolve) =>
      loader.load(
        "model.fbx",
        () => resolve(),
        undefined,
        (error) => (onError(error), resolve()),
      ),
    );
    expect(onError).toHaveBeenCalledOnce();
  });
});

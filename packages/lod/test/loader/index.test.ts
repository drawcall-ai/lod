import { bakeImpostor, cache, CacheEntry, gltsScene, sourceFixture } from "./fixture.js";
import { describe, expect, it, vi } from "vitest";
import { box } from "../box.js";
import { house, interior } from "../house.js";
import {
  BoxGeometry,
  DataTexture,
  Group,
  Loader,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  WebGPURenderer,
  type Object3D,
} from "three/webgpu";
import { Lod } from "../../src/lod.js";
import { InteriorMappingMaterial } from "../../src/baked/interior/material.js";
import { ImpostorMesh } from "../../src/impostor/mesh/index.js";
import { LodLoader } from "../../src/loader/index.js";
import { GPU_TIMEOUT, eventually, nextLevel, render, gpu } from "../renderer.js";
import type { LodRequest } from "../../src/loader/request.js";

vi.mock("vitecache", async () => {
  const { CacheEntry, MissingDependencyError } = await import("./fixture.js");
  return { CacheEntry, MissingDependencyError };
});
vi.mock("../../src/impostor/bake/index.js", async () => ({ bakeImpostor: (await import("./fixture.js")).bakeImpostor }));

const helper = "/models/helper.bin?shape=oak";
const extra = "/models/leaf.ts?size=small";

describe("LodLoader", () => {
  it("loads the baking auxiliaries only on a cache miss", async () => {
    const manager = new LoadingManager();
    manager.setURLModifier((url) => {
      if (url.startsWith("/resolved/")) throw new Error("URL modifier applied twice");
      return url.replace("/models/", "/resolved/");
    });
    const handler = new Loader<Object3D>();
    const load = vi.fn(async (url: string) => {
      const scene = url === "/models/rooms.glts#bake" ? interior() : url === "/models/house.glts?part=low" ? box() : house().add(interior());
      const source = { url: manager.resolveURL(url), dependencyUrls: [helper, extra, helper], packages: [], moduleHashes: {}, runtimeModules: [] };
      return gltsScene(source, ...(scene instanceof Group ? [...scene.children] : [scene]));
    });
    handler.loadAsync = load;
    manager.addHandler(/\.glts$/, handler);
    const request: LodRequest = {
      url: "house.glts?variant=2",
      levels: [{ type: "baked", low: "?part=low", interior: "rooms.glts#bake", textureSize: 32, maxPixels: 100 }],
    };
    const loader = new LodLoader(manager).setPath("/models/");
    const cold = (await loader.loadAsync(request))[1];
    if (!cold?.load) throw new Error("Expected a lazy baked level");
    await cold.load();
    const level = cache.saved.find(({ options }) => options.dependencies?.low);
    expect(level?.options.dependencies).toMatchObject({
      source: { url: "/resolved/house.glts?variant=2" },
      low: { url: "/resolved/house.glts?part=low" },
      interior: { url: "/resolved/rooms.glts#bake" },
    });
    const dependencies = level?.dependencies ?? {};
    expect(Object.values(dependencies).filter((value) => value.url === helper)).toHaveLength(1);
    expect(dependencies["resource:1"]).toEqual({ url: extra });
    // The source measured for the shape, which the build reuses, then the low shell and rooms.
    expect(load).toHaveBeenCalledTimes(3);
    const warm = await loader.loadAsync(request);
    const baked = await warm[1]?.load?.();
    expect(load).toHaveBeenCalledTimes(3);
    if (!(baked instanceof Mesh) || !(baked.material instanceof InteriorMappingMaterial)) throw new Error("Expected restored baked windows");
    expect(baked.material.rooms?.boxes).toHaveLength(1);
    const source = warm[0];
    if (!source?.load) throw new Error("Expected deferred GLTS source");
    expect((await source.load()).children).toHaveLength(house().children.length + 1);
    expect(load).toHaveBeenLastCalledWith("/models/house.glts?variant=2");
    expect(load).toHaveBeenCalledTimes(4);
  }, 120_000);

  it("builds a deferred level only on demand, from a source without onLevel effects, sharing the ladder source's textures", async () => {
    const { manager, load } = sourceFixture(() => {
      const map = new DataTexture(new Uint8Array([86, 98, 43, 0, 86, 98, 43, 255]), 2, 1);
      map.needsUpdate = true;
      const material = new MeshStandardMaterial({ map, alphaTest: 0.5 });
      return {
        scene: new Group().add(new Mesh(new SphereGeometry(1, 12, 8), material), new Mesh(new SphereGeometry(1, 12, 8), material.clone()).translateX(2)),
      };
    }, /\.glb$/);
    const loader = new LodLoader(manager).setPath("/models/");
    const request: LodRequest = {
      url: "tree.glb?seed=2",
      levels: [{ type: "simplify", ratio: 0.5, maxPixels: 100 }, { type: "impostor" }],
      onLevel: (object, index) => {
        if (index === 2) return;
        const first = object.children[0];
        if (!(first instanceof Mesh)) throw new Error("Expected mesh source");
        object.traverse((node) => {
          if (node instanceof Mesh) node.material = first.material;
        });
      },
    };
    await loader.loadAsync(request);
    expect(load).toHaveBeenCalledExactlyOnceWith("/models/tree.glb?seed=2");
    // Only the shape: the impostor's default threshold needs no build.
    expect(cache.saved).toHaveLength(1);
    const warm = await loader.loadAsync(request);
    expect(load).toHaveBeenCalledOnce();
    const source = warm[0];
    const detail = warm[1];
    if (!source?.load || !detail?.load) throw new Error("Expected deferred mesh levels");
    // The simplified level is built from a source without onLevel effects, then draws with the ladder source's materials.
    const simplified = await detail.load();
    expect(load).toHaveBeenCalledTimes(3);
    expect(cache.saved).toHaveLength(2);
    const original = await source.load();
    expect(load).toHaveBeenCalledTimes(3);
    const released = vi.fn();
    for (let index = 0; index < 2; index++) {
      const sourceMesh = original.children[index];
      const detailMesh = simplified.children[index];
      if (!(sourceMesh instanceof Mesh) || !(detailMesh instanceof Mesh) || !(sourceMesh.material instanceof MeshStandardMaterial))
        throw new Error("Expected original and simplified meshes");
      sourceMesh.geometry.addEventListener("dispose", released);
      expect(detailMesh.material).toBe(sourceMesh.material);
      if (!(sourceMesh.material.map instanceof DataTexture)) throw new Error("Expected original texture");
      expect(sourceMesh.material.map.image.data).toEqual(new Uint8Array([86, 98, 43, 0, 86, 98, 43, 255]));
    }
    // The last Lod holding the levels frees what the loader loaded, whoever asked for it.
    new Lod(warm, gpu).dispose();
    expect(released).toHaveBeenCalledTimes(2);
    const rewarmed = (await loader.loadAsync(request))[1];
    if (!rewarmed?.load) throw new Error("Expected lazy simplified level");
    await rewarmed.load();
    expect(load).toHaveBeenCalledTimes(4);
    expect(cache.saved).toHaveLength(2);
  });

  it("frees what it loaded once the last Lod holding the levels, clones included, is disposed", { timeout: GPU_TIMEOUT }, async () => {
    const { manager } = sourceFixture(() => ({ scene: new Group().add(new Mesh(new SphereGeometry(1, 12, 8), new MeshStandardMaterial())) }), /\.glb$/);
    const levels = await new LodLoader(manager).loadAsync({ url: "/models/shared.glb", levels: [{ type: "simplify", ratio: 0.5, maxPixels: 100 }] });
    const [first, second] = [new Lod(levels, gpu), new Lod(levels, gpu)];
    const clone = first.clone();
    // Only the simplified level draws, which reads the source's materials: the source loads for them alone.
    for (const lod of [first, second, clone]) lod.forceLevel = 1;
    second.position.z = -4;
    const scene = new Scene().add(second);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    try {
      await nextLevel(second, camera);
      const mesh = second.levels[1]?.object?.children[0];
      if (!(mesh instanceof Mesh)) throw new Error("Expected a simplified mesh");
      const freed = vi.fn();
      mesh.geometry.addEventListener("dispose", freed);
      mesh.material.addEventListener("dispose", freed);
      first.dispose();
      clone.dispose();
      expect(freed).not.toHaveBeenCalled();
      expect((await render(scene, camera)).some((byte) => byte > 0)).toBe(true);
      second.dispose();
      // Once its compiles have finished, the last holder frees the simplified level's geometry and the source's material.
      await eventually(() => expect(freed).toHaveBeenCalledTimes(2));
      // The freed levels are spent.
      expect(() => new Lod(levels, gpu)).toThrow("call loadAsync again");
    } finally {
      for (const lod of [first, second, clone]) lod.dispose();
    }
  });

  it("builds a level without maxPixels eagerly, since its default threshold is measured from it", async () => {
    const { manager, load } = sourceFixture(() => new Mesh(new SphereGeometry(1, 24, 16), new MeshStandardMaterial()), /\.glb$/);
    const loader = new LodLoader(manager);
    const request: LodRequest = {
      url: "/measured.glb",
      levels: [
        { type: "simplify", ratio: 0.2 },
        { type: "impostor", maxPixels: 20 },
      ],
    };
    const cold = await loader.loadAsync(request);
    // The measured level and the shape.
    expect(cache.saved).toHaveLength(2);
    cache.loaded.length = 0;
    const warm = await loader.loadAsync(request);
    // The impostor, which no camera needed, is not read.
    expect(cache.loaded).toEqual([true, true]);
    expect(load).toHaveBeenCalledOnce();
    expect(warm.map((level) => level.maxPixels)).toEqual(cold.map((level) => level.maxPixels));
  });

  it("rejects a derived level that extends beyond the source's bounds, which every level declares", async () => {
    const { manager } = sourceFixture(
      (url) => new Mesh(url.includes("part=low") ? new BoxGeometry(3, 3, 3) : new BoxGeometry(), new MeshStandardMaterial()),
      /\.glb$/,
    );
    const request: LodRequest = { url: "/shell.glb", levels: [{ type: "baked", low: "?part=low", textureSize: 32, maxPixels: 100 }] };
    const baked = (await new LodLoader(manager).loadAsync(request))[1];
    await expect(baked?.load?.()).rejects.toThrow("extends beyond the source's bounds");
    expect(cache.saved.map(({ options }) => options.dependencies?.["lod:level"]?.value)).toEqual([{ type: "shape" }]);
  });

  it("disposes the source measured for the shape once no level is left to build from it", async () => {
    const sources: Mesh[] = [];
    const { manager, load } = sourceFixture(() => sources[sources.push(new Mesh(new BoxGeometry(), new MeshStandardMaterial())) - 1]);
    const request: LodRequest = { url: "/spare.glb", levels: [{ type: "impostor", maxPixels: 100 }] };
    const loader = new LodLoader(manager);
    await (await loader.loadAsync(request))[1]?.load?.();
    // A cached level and a shape to measure again: the source measured is left over once the level has loaded.
    for (const [key] of cache.files) if (key.includes('"type":"shape"')) cache.files.delete(key);
    const levels = await loader.loadAsync(request);
    expect(load).toHaveBeenCalledTimes(2);
    const disposed = vi.fn();
    sources[1]?.geometry.addEventListener("dispose", disposed);
    await levels[1]?.load?.();
    expect(load).toHaveBeenCalledTimes(2);
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("disposes the source measured for the shape with a Lod disposed before any level loaded", async () => {
    const sources: Mesh[] = [];
    const { manager } = sourceFixture(() => sources[sources.push(new Mesh(new BoxGeometry(), new MeshStandardMaterial())) - 1]);
    const levels = await new LodLoader(manager).loadAsync({ url: "/unused.glb", levels: [{ type: "impostor", maxPixels: 100 }] });
    const disposed = vi.fn();
    sources[0]?.geometry.addEventListener("dispose", disposed);
    new Lod(levels, gpu).dispose();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("loads the source level once when its load is called directly, the level reading its materials included", async () => {
    const { manager, load } = sourceFixture(() => new Mesh(new SphereGeometry(1, 12, 8), new MeshStandardMaterial()));
    const loader = new LodLoader(manager);
    const request: LodRequest = { url: "/direct.glb", levels: [{ type: "simplify", ratio: 0.5, maxPixels: 100 }] };
    await (await loader.loadAsync(request))[1]?.load?.();
    load.mockClear();
    const [source, detail] = await loader.loadAsync(request);
    if (!source?.load || !detail?.load) throw new Error("Expected deferred mesh levels");
    const object = await source.load();
    await detail.load();
    expect(await source.load()).toBe(object);
    expect(load).toHaveBeenCalledOnce();
  });

  it("preloads a placed source when it is the only drawable, on cold and warm loads", async () => {
    const { manager, load } = sourceFixture(() => new Mesh(new BoxGeometry(), new MeshStandardMaterial()).translateX(7), /\.glb$/);
    const request: LodRequest = { url: "/source.glb", levels: [{ type: "empty", maxPixels: 1 }] };
    const loader = new LodLoader(manager);
    for (let run = 0; run < 2; run++) {
      const levels = await loader.loadAsync(request);
      expect(levels[0]?.object?.position.x).toBe(7);
      expect(levels[1]?.object?.children).toEqual([]);
    }
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("bakes with a renderer of its own, which dispose frees", async () => {
    const { manager } = sourceFixture(() => new Mesh(new BoxGeometry(), new MeshStandardMaterial()), /\.glb$/);
    const loader = new LodLoader(manager);
    const levels = await loader.loadAsync({ url: "/baker.glb", levels: [{ type: "impostor", maxPixels: 100 }] });
    await levels[1]?.load?.();
    const renderer = bakeImpostor.mock.calls[0]?.[1];
    if (!(renderer instanceof WebGPURenderer)) throw new Error("Expected the loader's renderer");
    const disposed = vi.spyOn(renderer, "dispose");
    loader.dispose();
    await eventually(() => expect(disposed).toHaveBeenCalledOnce());
  });

  it("reuses cached levels when only a switch threshold or draw option changes", async () => {
    const { manager, load } = sourceFixture(() => new Mesh(new BoxGeometry(), new MeshStandardMaterial()), /\.glb$/);
    const loader = new LodLoader(manager);
    const levels = (empty: number, parallax: number) =>
      loader.loadAsync({
        url: "/switch.glb",
        levels: [
          { type: "impostor", maxPixels: 100, draw: { parallax } },
          { type: "empty", maxPixels: empty },
        ],
      });
    const cold = await levels(10, 1);
    const coldImpostor = await cold[1]?.load?.();
    const saved = cache.saved.length;
    const loads = load.mock.calls.length;
    const warm = await levels(20, 0);
    const warmImpostor = await warm[1]?.load?.();
    expect(cache.saved).toHaveLength(saved);
    expect(bakeImpostor).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(loads);
    expect(cold.map((level) => level.maxPixels)).toEqual([Infinity, 100, 10]);
    expect(warm.map((level) => level.maxPixels)).toEqual([Infinity, 100, 20]);
    expect([coldImpostor, warmImpostor].map((object) => (object instanceof ImpostorMesh ? object.options.parallax : undefined))).toEqual([1, 0]);
  });

  it("builds a deferred level again when the cache skips saving", async () => {
    const save = vi.spyOn(CacheEntry.prototype, "save").mockResolvedValue();
    try {
      const { manager, load } = sourceFixture(() => new Mesh(new SphereGeometry(1, 12, 8), new MeshStandardMaterial()), /\.glb$/);
      const levels = await new LodLoader(manager).loadAsync({
        url: "/unsaved.glb",
        levels: [{ type: "simplify", ratio: 0.5, maxPixels: 100 }, { type: "impostor" }],
      });
      expect(save).toHaveBeenCalled();
      expect(cache.files.size).toBe(0);
      const simplified = levels[1];
      if (!simplified?.load) throw new Error("Expected lazy simplified level");
      expect(await simplified.load()).toBeInstanceOf(Mesh);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      save.mockRestore();
    }
  });

  it("finishes the empty level's hook before the first update, which draws nothing before the coarsest level that draws, on cold and warm loads", async () => {
    const { manager, load } = sourceFixture(() => new Mesh(new BoxGeometry(), new MeshStandardMaterial()), /\.glb$/);
    const released = vi.fn();
    const request: LodRequest = {
      url: "/culled.glb",
      levels: [
        { type: "impostor", maxPixels: 100 },
        { type: "empty", maxPixels: 10 },
      ],
      onLevel: async (object, index) => {
        if (index !== 2) return;
        await Promise.resolve();
        object.position.set(2, 3, 4);
        Object.assign(object, { dispose: released });
      },
    };
    const camera = new PerspectiveCamera(60, 1, 0.1, 100_000);
    camera.position.z = 10_000;
    camera.updateMatrixWorld();
    const loader = new LodLoader(manager);
    for (let run = 0; run < 2; run++) {
      const levels = await loader.loadAsync(request);
      const lod = new Lod(levels, gpu);
      new Scene().add(lod);
      lod.updateMatrixWorld();
      lod.update(camera);
      expect(lod.error).toBeUndefined();
      // Far away the empty level would draw, but nothing does before the impostor, the coarsest level that draws.
      expect(lod.levels.flatMap(({ object }, index) => (object?.visible ? [index] : []))).toEqual([]);
      expect(levels[2]?.object?.position.toArray()).toEqual([2, 3, 4]);
      // Nothing loaded the impostor before a renderer drew the Lod: the source gave the shape once, which its cache entry then does.
      expect(load).toHaveBeenCalledOnce();
      lod.dispose();
      expect(released).toHaveBeenCalledTimes(run + 1);
    }
  });

  // Cold, the ladder loads its source to measure the shape and preloads its empty level; warm, only the empty level.
  it.each([false, true])("releases what a ladder loaded exactly once when the empty level's hook rejects (warm: %s)", async (warm) => {
    const sources: Array<{ object: Object3D; release: ReturnType<typeof vi.fn> }> = [];
    const { manager } = sourceFixture((url) => {
      const geometry = new BoxGeometry();
      const material = new MeshStandardMaterial();
      const release = vi.fn(() => {
        geometry.dispose();
        material.dispose();
      });
      const object = Object.assign(new Scene().add(new Mesh(geometry, material)), {
        source: { url, dependencyUrls: [], packages: [], moduleHashes: {}, runtimeModules: [] },
        dispose: release,
      });
      sources.push({ object, release });
      return object;
    });
    const loader = new LodLoader(manager);
    const request: LodRequest = {
      url: "/source.glts",
      levels: [
        { type: "simplify", ratio: 0.5, maxPixels: 100 },
        { type: "empty", maxPixels: 1 },
      ],
    };
    if (warm) {
      const levels = await loader.loadAsync(request);
      await levels[1]?.load?.();
      new Lod(levels, gpu).dispose();
      sources.length = 0;
    }
    const released = new Map<number, ReturnType<typeof vi.fn>>();
    const failure = new Error("level hook failed");
    await expect(
      loader.loadAsync({
        ...request,
        onLevel: async (object, level) => {
          if (level === 0) {
            const source = sources.find((source) => source.object === object);
            if (!source) throw new Error("Expected loaded source");
            released.set(level, source.release);
          } else {
            const release = vi.fn();
            released.set(level, release);
            if (level === 2) Object.assign(object, { dispose: release });
            else
              object.traverse((node) => {
                if (node instanceof Mesh) node.geometry.addEventListener("dispose", release);
              });
          }
          await Promise.resolve();
          if (level === 2) throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(sources).toHaveLength(warm ? 0 : 1);
    for (const source of sources) expect(source.release).toHaveBeenCalledOnce();
    expect([...released.keys()]).toEqual([2]);
    for (const release of released.values()) expect(release).toHaveBeenCalledOnce();
  });
});

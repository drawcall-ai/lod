import { BoxGeometry, Group, Loader, LoadingManager, Mesh, MeshStandardMaterial, SphereGeometry } from "three";
import { describe, expect, it, vi } from "vitest";
import { InstancedLod } from "../src/instanced/index.js";
import { LodLoader } from "../src/loader.js";
import { isImpostorMesh } from "../src/three.js";
import { house, interior, low } from "./house.js";
import { GPU_TIMEOUT, renderer } from "./webgl.js";

// The loader's impostors and rooms bake on the test's WebGL context.
vi.mock(import("../src/impostor/bake/index.js"), async (original) => {
  const module = await original();
  return { ...module, bakeImpostor: (object, options) => module.bakeImpostor(object, { ...options, renderer }) };
});
vi.mock(import("../src/baked/index.js"), async (original) => {
  const module = await original();
  return { ...module, bakeMesh: (object, options) => module.bakeMesh(object, { ...options, renderer }) };
});

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

describe("LodLoader", { timeout: GPU_TIMEOUT }, () => {
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
      { type: "baked", low: "house-low.glts", interior: "rooms.glts", textureSize: 32 },
      { type: "impostor", resolution: 16, frames: 4 },
    ] as const;
    const lod = await new LodLoader(manager).setPath("/models/").loadAsync({ url: "house.glb", levels });
    expect(loads).toEqual(["/models/house.glb", "/models/house-low.glts", "/models/rooms.glts"]);
    expect(rooms.parent).toBe(scene);
    expect(lod.levels).toHaveLength(3);
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

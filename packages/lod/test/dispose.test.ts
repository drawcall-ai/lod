import { GLTSLoader } from "@drawcall/glts";
import { Box3, BoxGeometry, LoadingManager, Mesh, MeshBasicMaterial, Scene, Texture } from "three/webgpu";
import { expect, it, vi } from "vitest";
import { disposeRecursive } from "../src/dispose.js";
import { decodeMeshAsync, encodeMeshAsync } from "../src/codec/mesh.js";
import { Lod } from "../src/lod.js";
import { isGLTSScene } from "../src/three.js";
import { drawnMeshes } from "./instanced/fixture.js";

it("lets a GLTS source release its resources while preserving shared host textures", async () => {
  const texture = new Texture();
  const disposed = vi.spyOn(texture, "dispose");
  const cleanup = vi.fn();
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(`
    import { scene, onDispose } from "@drawcall/glts";
    import { BoxGeometry, Mesh, MeshBasicMaterial } from "three";
    import { texture, cleanup } from "host";
    const geometry = new BoxGeometry();
    const material = new MeshBasicMaterial({ map: texture });
    scene.add(new Mesh(geometry, material));
    onDispose(() => { geometry.dispose(); material.dispose(); cleanup(); });
  `),
  );
  const loader = new GLTSLoader(new LoadingManager(), { modules: { host: { texture, cleanup } } });
  try {
    const source = await loader.loadAsync("https://assets.test/owned.glts");
    // A clone is a plain Scene: disposing it fires its draw state's release, not the script's.
    expect(isGLTSScene(source)).toBe(true);
    expect(isGLTSScene(source.clone())).toBe(false);
    expect(isGLTSScene(Object.assign(new Scene(), { source: source.source }))).toBe(false);
    const mesh = source.children[0];
    if (!(mesh instanceof Mesh) || Array.isArray(mesh.material)) throw new Error("Missing source mesh");
    const geometryDisposed = vi.fn();
    const materialDisposed = vi.fn();
    mesh.geometry.addEventListener("dispose", geometryDisposed);
    mesh.material.addEventListener("dispose", materialDisposed);
    // A coarse level decoded from it draws with its materials: only the source frees them.
    const coarse = await decodeMeshAsync(await encodeMeshAsync(source, [mesh.material]), [mesh.material]);
    disposeRecursive(coarse, { materials: false });
    expect(materialDisposed).not.toHaveBeenCalled();
    disposeRecursive(source);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(geometryDisposed).toHaveBeenCalledOnce();
    expect(materialDisposed).toHaveBeenCalledOnce();
    expect(disposed).not.toHaveBeenCalled();
  } finally {
    loader.dispose();
    fetch.mockRestore();
    disposed.mockRestore();
    texture.dispose();
  }
});

it("frees a template's textures but leaves their ImageBitmap to the copies that still share it", async () => {
  const image = await createImageBitmap(new ImageData(1, 1));
  const map = new Texture(image);
  const disposed = vi.spyOn(map, "dispose");
  const source = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ map }));
  const lod = new Lod([{ object: source }]);
  disposeRecursive(source);
  expect(disposed).toHaveBeenCalled();
  // A closed bitmap has no size: the copy could no longer upload it.
  expect(image.width).toBe(1);
  lod.dispose();
});

it(
  "leaves given objects to whoever made them, and holds each level once per Lod, a copy included, until disposed",
  () => {
    const source = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    const freed = vi.fn();
    source.geometry.addEventListener("dispose", freed);
    source.material.addEventListener("dispose", freed);
    const released = vi.fn();
    const hold = vi.fn(() => released);
    const load = vi.fn(async () => new Mesh());
    const levels = [
      { object: source, hold },
      { load, maxPixels: 10, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]), hold },
    ];
    const lod = new Lod(levels);
    const copy = lod.clone();
    expect(hold).toHaveBeenCalledTimes(2);
    lod.dispose();
    expect(released).toHaveBeenCalledOnce();
    copy.dispose();
    expect(released).toHaveBeenCalledTimes(2);
    expect(load).not.toHaveBeenCalled();
    expect(freed).not.toHaveBeenCalled();
  },
);

it("frees the draw state of every level mesh once, of the source and of each copy", () => {
  const lod = new Lod([{ object: new Mesh(new BoxGeometry(), new MeshBasicMaterial()) }]);
  const copy = lod.clone();
  const geometries = [lod, copy].flatMap(drawnMeshes).map((mesh) => mesh.geometry);
  expect(new Set(geometries).size).toBe(2);
  const freed = new Map<object, number>();
  for (const geometry of geometries) geometry.addEventListener("dispose", () => freed.set(geometry, (freed.get(geometry) ?? 0) + 1));
  lod.dispose();
  copy.dispose();
  lod.dispose();
  expect([...freed.values()]).toEqual([1, 1]);
});

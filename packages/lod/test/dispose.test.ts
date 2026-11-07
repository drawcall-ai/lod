import { GLTSLoader } from "@drawcall/glts";
import { Box3, BoxGeometry, LoadingManager, Mesh, MeshBasicMaterial, Scene, Texture } from "three/webgpu";
import { expect, it, vi } from "vitest";
import { InstancedLod } from "../src/instanced/index.js";
import { decodeMeshAsync, encodeMeshAsync } from "../src/mesh/codec.js";
import { Lod } from "../src/lod.js";
import { isGLTSScene } from "../src/three.js";

it.each([Lod, InstancedLod])("lets the GLTS source release its resources while preserving shared host textures (%s)", async (Type) => {
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
    const coarse = await decodeMeshAsync(await encodeMeshAsync(source, [mesh.material]), [mesh.material]);
    const owner = new Type([{ object: source }, { object: coarse }]);
    const clone = owner.clone();
    owner.dispose();
    clone.dispose();
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
  const lod = new Lod([{ object: new Mesh(new BoxGeometry(), new MeshBasicMaterial({ map })) }]);
  const copy = lod.clone();
  lod.dispose();
  expect(disposed).toHaveBeenCalled();
  // A closed bitmap has no size: the copy could no longer upload it.
  expect(image.width).toBe(1);
  copy.dispose();
});

it.each([Lod, InstancedLod].map((Type) => ({ name: Type.name, Type })))(
  "frees what a deferred level holds for a load that never ran when its owner is disposed ($name)",
  ({ Type }) => {
    const dispose = vi.fn();
    const load = vi.fn(async () => new Mesh());
    new Type([
      { object: new Mesh(new BoxGeometry(), new MeshBasicMaterial()) },
      { load, maxPixels: 10, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]), dispose },
    ]).dispose();
    expect(load).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  },
);

it("frees the draw state of every level mesh once, of the source and of each copy", () => {
  const lod = new Lod([{ object: new Mesh(new BoxGeometry(), new MeshBasicMaterial()) }]);
  const copy = lod.clone();
  const freed = new Map<object, number>();
  for (const owner of [lod, copy])
    owner.traverse((node) => node.addEventListener("dispose", () => freed.set(node, (freed.get(node) ?? 0) + 1)));
  lod.dispose();
  copy.dispose();
  lod.dispose();
  const meshes = [lod, copy].flatMap((owner) => owner.getObjectsByProperty("isMesh", true));
  expect(meshes).toHaveLength(2);
  expect([...freed.values()]).toEqual([1, 1, 1, 1]);
  for (const mesh of meshes) expect(freed.get(mesh)).toBe(1);
});

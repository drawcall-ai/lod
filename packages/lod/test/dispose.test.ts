import { GLTSLoader } from "@drawcall/glts";
import { LoadingManager, Mesh, Texture } from "three/webgpu";
import { expect, it, vi } from "vitest";
import { InstancedLod } from "../src/instanced/index.js";
import { decodeMeshAsync, encodeMesh } from "../src/mesh/codec.js";
import { Lod } from "../src/lod.js";

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
    const mesh = source.children[0];
    if (!(mesh instanceof Mesh) || Array.isArray(mesh.material)) throw new Error("Missing source mesh");
    const geometryDisposed = vi.fn();
    const materialDisposed = vi.fn();
    mesh.geometry.addEventListener("dispose", geometryDisposed);
    mesh.material.addEventListener("dispose", materialDisposed);
    const coarse = await decodeMeshAsync(encodeMesh(source, [mesh.material]), [mesh.material]);
    const owner = new Type([{ object: source }, { object: coarse }], 2);
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

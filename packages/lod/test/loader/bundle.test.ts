import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Object3D } from "three/webgpu";
import { expect, it, vi } from "vitest";
import { decode, encode, separateLevels } from "../../src/loader/bundle.js";

it("exposes source-only metadata lazily and releases a level when its onLevel hook fails", async () => {
  const material = new MeshStandardMaterial({ name: "surface" });
  const source = new Mesh(new BoxGeometry(), material);
  source.position.set(2, 3, 4);
  const cached = await encode([source, new Group()], ["source", "empty"]);
  const failure = new Error("shading failed");
  const released = vi.fn();
  const onLevel = vi.fn(async (object: Object3D) => {
    if (!(object instanceof Mesh)) throw new Error("Expected mesh");
    expect(object.position.toArray()).toEqual([2, 3, 4]);
    object.geometry.addEventListener("dispose", released);
    throw failure;
  });
  const fetch = vi.fn(async () => new Uint8Array());
  const levels = decode(cached.index, [{}, { maxPixels: 1 }], async () => source, fetch, onLevel);
  const deferred = levels[0];
  if (!deferred?.load) throw new Error("Expected deferred source");
  expect(deferred.box.min.toArray()).toEqual([1.5, 2.5, 3.5]);
  expect(deferred.box.getSize(source.position).toArray()).toEqual([1, 1, 1]);
  expect(onLevel).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  await expect(deferred.load()).rejects.toBe(failure);
  expect(released).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  expect(cached.levels.size).toBe(0);
});

it("saves every derived drawable level but the inlined coarsest, and rejects one with an empty box", async () => {
  expect(separateLevels(["source", "simplify", "impostor", "empty"])).toEqual([1]);
  expect(separateLevels(["source", "empty"])).toEqual([]);
  const source = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  await expect(encode([source, new Group()], ["source", "impostor"])).rejects.toThrow("impostor level 1 has an empty box");
});

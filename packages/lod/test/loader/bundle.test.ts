import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Object3D } from "three/webgpu";
import { expect, it, vi } from "vitest";
import { disposeTree } from "../../src/dispose.js";
import { decode, encode } from "../../src/loader/bundle.js";

it("exposes source-only metadata lazily and releases a level when its restore hook fails", async () => {
  const material = new MeshStandardMaterial({ name: "surface" });
  const source = new Mesh(new BoxGeometry(), material);
  source.position.set(2, 3, 4);
  const resolve = (name: string) => (name === "surface" ? material : undefined);
  const cached = await encode([source, new Group()], ["mesh", "empty"], [Infinity, 1], resolve);
  disposeTree(source);
  const failure = new Error("shading failed");
  const released = vi.fn();
  const restore = vi.fn(async (object: Object3D) => {
    if (!(object instanceof Mesh)) throw new Error("Expected mesh");
    expect(object.position.toArray()).toEqual([2, 3, 4]);
    object.geometry.addEventListener("dispose", released);
    throw failure;
  });
  const fetch = vi.fn(async () => {
    const payload = cached.levels[0];
    if (!payload) throw new Error("Missing source payload");
    return payload.bytes;
  });
  const levels = decode(cached.index, async () => source, fetch, restore, resolve);
  const deferred = levels[0];
  if (!deferred?.load) throw new Error("Expected deferred source");
  expect(deferred.box.min.toArray()).toEqual([1.5, 2.5, 3.5]);
  expect(deferred.box.getSize(source.position).toArray()).toEqual([1, 1, 1]);
  expect(restore).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  await expect(deferred.load()).rejects.toBe(failure);
  expect(released).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledExactlyOnceWith(0);
});

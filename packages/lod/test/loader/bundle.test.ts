import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Object3D } from "three/webgpu";
import { expect, it, vi } from "vitest";
import { disposeTree } from "../../src/dispose.js";
import { LazyLevel } from "../../src/lazy.js";
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
    object.geometry.addEventListener("dispose", released);
    throw failure;
  });
  const fetch = vi.fn(async () => {
    const payload = cached.levels[0];
    if (!payload) throw new Error("Missing source payload");
    return payload.bytes;
  });
  const levels = decode(cached.index, async () => source, fetch, restore, resolve);
  const lazy = levels[0]?.object;
  if (!(lazy instanceof LazyLevel)) throw new Error("Expected lazy source");
  expect(lazy.position.toArray()).toEqual([2, 3, 4]);
  expect(lazy.box.getSize(source.position).toArray()).toEqual([1, 1, 1]);
  expect(restore).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  try {
    await expect(lazy.load()).rejects.toBe(failure);
    expect(released).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(0);
  } finally {
    levels.forEach(({ object }) => disposeTree(object));
  }
});

import { Box3, BoxGeometry, Mesh, MeshBasicMaterial, Object3D } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { LazyLevel } from "../src/lazy.js";

const box = new Box3().setFromArray([-1, -1, -1, 1, 1, 1]);
const mesh = () => new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());

describe("LazyLevel", () => {
  it("memoizes one fetch and decode across clones", async () => {
    const load = vi.fn(async () => mesh());
    const source = new LazyLevel(load, { maxPixels: Infinity, box });
    const clone = source.clone();
    try {
      const first = source.load();
      expect(clone.load()).toBe(first);
      const object = await first;
      expect(await clone.load()).toBe(object);
      expect(load).toHaveBeenCalledOnce();
    } finally {
      source.dispose();
    }
  });

  it("shares a failure across clones without retrying it", async () => {
    const load = vi.fn<() => Promise<Object3D>>().mockRejectedValue(undefined);
    const lazy = new LazyLevel(load, { maxPixels: Infinity, box });
    const clone = lazy.clone();
    await expect(lazy.load()).rejects.toThrow("load failed");
    expect(clone.error).toBe(lazy.error);
    await expect(clone.load()).rejects.toBe(lazy.error);
    expect(load).toHaveBeenCalledOnce();
  });
});

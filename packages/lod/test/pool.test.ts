import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { InstancedLod } from "../src/instanced/index.js";
import { LodPool } from "../src/pool.js";
import { oneChunk } from "./instances.js";
import { GPU_TIMEOUT, render } from "./renderer.js";

const levels = () => [{ object: new Mesh(new BoxGeometry(), new MeshBasicMaterial()) }];

describe("LodPool", () => {
  it("refuses to make an InstancedLod once disposed", () => {
    const disposed = new LodPool();
    disposed.dispose();
    expect(() => new InstancedLod(levels(), disposed)).toThrow("LodPool: disposed");
  });

  it("reports a pool outgrowing its first renderer's storage binding limit when that renderer draws it", { timeout: GPU_TIMEOUT }, async () => {
    const limit = vi.spyOn(GPUSupportedLimits.prototype, "maxStorageBufferBindingSize", "get").mockReturnValue(2 ** 20);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const on = new LodPool();
    const lod = oneChunk(levels(), 1, { on });
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 5;
    try {
      expect(lod.error).toBeUndefined();
      await render(new Scene().add(lod), camera);
      expect(lod.error?.message).toMatch(/outgrow the device's storage binding of 1048576 bytes/);
    } finally {
      limit.mockRestore();
      vi.mocked(console.error).mockRestore();
      lod.dispose();
      on.dispose();
    }
  });
});

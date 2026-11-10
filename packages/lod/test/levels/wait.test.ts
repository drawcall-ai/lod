import { Scene } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GPU_TIMEOUT, renderer } from "../renderer.js";
import { camera, gpuChunk, instancedLod, produce } from "../instanced/pages/fixture.js";

afterEach(() => vi.restoreAllMocks());

describe("an InstancedLod's wait for its chunks", { timeout: GPU_TIMEOUT }, () => {
  it("reads nothing back while chunks come and go and cameras move, and reads once they rest", async () => {
    const lod = instancedLod();
    const readback = vi.spyOn(GPUBuffer.prototype, "mapAsync");
    const scene = new Scene().add(lod);
    try {
      for (let i = 0; i < 4; i++) {
        produce(0, 500, 0);
        const chunk = lod.addChunk(gpuChunk(500, 0));
        camera.position.x = i;
        camera.updateMatrixWorld();
        renderer.render(scene, camera);
        if (i % 2 === 1) lod.removeChunk(chunk);
      }
      renderer.render(scene, camera);
      expect(readback).not.toHaveBeenCalled();
      for (let i = 0; i < 8; i++) renderer.render(scene, camera);
      expect(readback).toHaveBeenCalled();
    } finally {
      camera.position.set(0, 0, 0);
      camera.updateMatrixWorld();
      lod.dispose();
    }
  });
});

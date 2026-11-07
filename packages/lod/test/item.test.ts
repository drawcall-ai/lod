import { ACESFilmicToneMapping, BoxGeometry, LoadingManager, Mesh, MeshBasicNodeMaterial, NodeMaterial, NoToneMapping, PerspectiveCamera, Scene } from "three/webgpu";
import { expect, it, vi } from "vitest";
import { Lod } from "../src/lod.js";
import { GPU_TIMEOUT, renderer } from "./gpu.js";
import { oneChunk } from "./crowd.js";

const box = () => new Mesh(new BoxGeometry(), new MeshBasicNodeMaterial());

it.each(["Lod", "InstancedLod"])(
  "learns the renderer of a %s from its first render, without the scene's hook and without a draw of its own",
  { timeout: GPU_TIMEOUT },
  async (kind) => {
    const own = vi.fn();
    const scene = new Scene();
    scene.onBeforeRender = own;
    const owner = kind === "Lod" ? new Lod([{ object: box() }]) : oneChunk([{ object: box() }], 1);
    owner.position.z = -5;
    scene.add(owner);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const children = [...owner.children];
    const builds = vi.spyOn(NodeMaterial.prototype, "setup");
    try {
      renderer.render(scene, camera);
      // The mesh that asked left, and three built nothing for it: only the given level draws.
      expect(owner.children).toEqual(children);
      expect(builds.mock.calls.some(([builder]) => !builder.material.colorWrite)).toBe(false);
      renderer.render(scene, camera);
      expect(scene.onBeforeRender).toBe(own);
      expect(own).toHaveBeenCalledTimes(2);
    } finally {
      builds.mockRestore();
      owner.dispose();
    }
  },
);

it.each(["Lod", "InstancedLod"])(
  "reports a failure inside three's render instead of throwing, and the next render reaches the canvas (%s)",
  { timeout: GPU_TIMEOUT },
  async (kind) => {
    const manager = new LoadingManager();
    const failed = vi.fn();
    manager.onError = failed;
    const levels = [{ object: box() }];
    const owner = kind === "Lod" ? new Lod(levels, { manager }) : oneChunk(levels, 1, { manager });
    owner.position.z = -5;
    owner.forceLevel = 3;
    const scene = new Scene().add(owner);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    // Tone mapping draws the canvas through three's framebuffer target, which a throw would leave bound.
    renderer.toneMapping = ACESFilmicToneMapping;
    try {
      expect(() => renderer.render(scene, camera)).not.toThrow();
      expect(renderer.getRenderTarget()).toBeNull();
      expect(report).toHaveBeenCalledOnce();
      // The manager hears of it once the render has returned.
      expect(failed).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(failed).toHaveBeenCalledOnce();
      expect(owner.error?.message).toMatch(/forceLevel 3 is not a level/);
      renderer.render(scene, camera);
      expect(renderer.getRenderTarget()).toBeNull();
      expect(report).toHaveBeenCalledOnce();
    } finally {
      renderer.toneMapping = NoToneMapping;
      report.mockRestore();
      owner.dispose();
    }
  },
);

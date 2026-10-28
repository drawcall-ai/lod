/// <reference types="@webgpu/types" />
import {
  Box3,
  BoxGeometry,
  DataTexture,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Object3D,
  PerspectiveCamera,
  RenderTarget,
  Scene,
} from "three/webgpu";
import { mrt, output, texture, vec3, vec4 } from "three/tsl";
import { expect, it, vi } from "vitest";
import { Lod } from "../src/lod.js";
import { InstancedLod } from "../src/instanced/index.js";
import { LazyLevel } from "../src/lazy.js";
import { ImpostorMesh } from "../src/impostor/mesh/index.js";
import * as surface from "../src/impostor/mesh/surface.js";
import { compileLevel } from "../src/install.js";
import { GPU_TIMEOUT, renderer, nextLevel } from "./gpu.js";

vi.mock("../src/impostor/mesh/surface.js", { spy: true });

it(
  "precompiles hidden grouped draws for the captured target and MRT",
  async () => {
    const target = new RenderTarget(32, 32, { count: 2, samples: 4 });
    const color = target.textures[0],
      normal = target.textures[1];
    if (!color || !normal) throw new Error("missing MRT textures");
    color.name = "output";
    normal.name = "normal";
    const outputs = mrt({ output, normal: vec4(0, 0, 1, 1) });
    const childMaterial = new MeshBasicNodeMaterial();
    childMaterial.colorNode = vec3(0.25, 0.5, 0.75);
    const materials = [new MeshBasicNodeMaterial(), new MeshStandardNodeMaterial(), childMaterial, new MeshBasicNodeMaterial({ color: "red" })];
    const geometry = new BoxGeometry();
    geometry.clearGroups();
    geometry.addGroup(0, 18, 0);
    geometry.addGroup(18, 18, 1);
    const grouped = new Mesh(geometry, materials.slice(0, 2));
    grouped.add(new Mesh(new BoxGeometry(), materials[2]));
    grouped.visible = false;
    grouped.position.x = 1000;
    const object = new Group().add(grouped, new Mesh(new BoxGeometry(), materials[3]));
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 4;
    camera.updateMatrixWorld();
    const scene = new Scene();
    const background = new DataTexture(new Uint8Array([32, 64, 96, 255]), 1, 1);
    background.needsUpdate = true;
    scene.background = background;
    try {
      renderer.setRenderTarget(target);
      renderer.setMRT(outputs);
      await renderer.compileAsync(scene, camera);
      renderer.setRenderTarget(null);
      renderer.setMRT(null);
      await Promise.all(object.children.map((draw) => compileLevel(draw, { renderer, camera, scene, target, mrt: outputs, cubeFace: 0, mipLevel: 0 })));
      expect(renderer.getRenderTarget()).toBeNull();
      expect(renderer.getMRT()).toBeNull();
      expect(scene.background).toBe(background);
      const synchronous = vi.spyOn(GPUDevice.prototype, "createRenderPipeline");
      try {
        renderer.setRenderTarget(target);
        renderer.setMRT(outputs);
        grouped.visible = true;
        grouped.position.x = 0;
        renderer.render(scene.add(object), camera);
        expect(synchronous).not.toHaveBeenCalled();
      } finally {
        synchronous.mockRestore();
        renderer.setRenderTarget(null);
        renderer.setMRT(null);
      }
    } finally {
      object.traverse((child) => {
        if (child instanceof Mesh) child.geometry.dispose();
      });
      for (const material of materials) material.dispose();
      background.dispose();
      target.dispose();
    }
  },
  GPU_TIMEOUT,
);

it.each(["texture", "node"])(
  "keeps the impostor MSAA variant with a %s background across async shader-stage yields",
  async (kind) => {
    const card = new ImpostorMesh({
      version: 3,
      layout: "full",
      frames: 4,
      size: 16,
      box: [-1, -1, -1, 1, 1, 1],
      halfSize: 1.5,
      maps: ["base", "normalDepth", "orm"],
      layers: [0, 1, 2].map(() => [16, 8, 4].map((size) => new Uint8Array(size * size * 4))),
    });
    const target = new RenderTarget(32, 32, { samples: 4 });
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 4;
    camera.updateMatrixWorld();
    const scene = new Scene();
    const background = new DataTexture(new Uint8Array([32, 64, 96, 255]), 1, 1);
    background.needsUpdate = true;
    if (kind === "texture") scene.background = background;
    else scene.backgroundNode = texture(background).rgb;
    const backgroundNode = scene.backgroundNode;
    try {
      renderer.setRenderTarget(null);
      vi.mocked(surface.buildSurface).mockClear();
      await compileLevel(card, { renderer, camera, scene, target, mrt: renderer.getMRT(), cubeFace: 0, mipLevel: 0 });
      expect(renderer.getRenderTarget()).toBeNull();
      expect(scene.background).toBe(kind === "texture" ? background : null);
      expect(scene.backgroundNode).toBe(backgroundNode);
      expect(surface.buildSurface).toHaveBeenCalled();
      for (const [, , pass] of vi.mocked(surface.buildSurface).mock.calls) expect(pass.multisampled).toBe(true);
    } finally {
      card.dispose();
      background.dispose();
      target.dispose();
    }
  },
  GPU_TIMEOUT,
);

it.each(["Lod", "InstancedLod"])(
  "keeps %s on its fallback until compilation finishes and defers disposal",
  async (kind) => {
    const source = new Mesh(new BoxGeometry(), new MeshBasicNodeMaterial());
    const fallback = new Mesh(new BoxGeometry(), new MeshBasicNodeMaterial());
    const lazy = new LazyLevel(async () => source, { maxPixels: Infinity, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) });
    const owner = kind === "Lod" ? new Lod([lazy, fallback]) : new InstancedLod([lazy, fallback], 1);
    owner.autoUpdate = false;
    owner.forceLevel = 0;
    owner.position.z = -5;
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const scene = new Scene().add(owner);
    let finish = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let begin = () => {};
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const released = new Promise<void>((resolve) => source.geometry.addEventListener("dispose", () => resolve()));
    const disposed = vi.spyOn(source.geometry, "dispose");
    const installed = vi.fn();
    owner.addEventListener("levelschange", installed);
    const original = renderer.compileAsync.bind(renderer);
    try {
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld();
      owner.update(camera);
      renderer.render(scene, camera);
      await lazy.load();
      vi.spyOn(renderer, "compileAsync").mockImplementation(async (...args) => {
        begin();
        await original(...args);
        await gate;
      });
      owner.update(camera);
      await started;
      owner.update(camera);
      expect(installed).not.toHaveBeenCalled();
      if (owner instanceof InstancedLod) {
        expect(owner.levelOf(0)).toBe(1);
        expect(owner.children).toHaveLength(1);
      } else {
        expect(lazy.visible).toBe(false);
        expect(fallback.visible).toBe(true);
      }
      owner.dispose();
      expect(disposed).not.toHaveBeenCalled();
      finish();
      await released;
      expect(installed).not.toHaveBeenCalled();
    } finally {
      finish();
      vi.restoreAllMocks();
      owner.dispose();
    }
  },
  GPU_TIMEOUT,
);

it.each(["Lod", "InstancedLod"])("discovers the view through %s's empty eager fallback", { timeout: GPU_TIMEOUT }, async (kind) => {
  const load = vi.fn(async () => new Mesh(new BoxGeometry(), new MeshBasicNodeMaterial()));
  const lazy = new LazyLevel(load, { maxPixels: Infinity, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) });
  const levels = [lazy, new Object3D()];
  const owner = kind === "Lod" ? new Lod(levels) : new InstancedLod(levels, 1);
  owner.forceLevel = 0;
  owner.position.set(1000, 0, -5);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const scene = new Scene().add(owner);
  try {
    renderer.render(scene, camera);
    owner.update(camera);
    expect(load).not.toHaveBeenCalled();
    owner.position.x = 0;
    owner.updateMatrixWorld();
    await nextLevel(owner, camera);
    expect(load).toHaveBeenCalledOnce();
    expect(owner.pending).toBe(false);
    expect(owner.error).toBeUndefined();
  } finally {
    owner.dispose();
  }
});

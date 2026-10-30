/// <reference types="@webgpu/types" />
import { BoxGeometry, DataTexture, Group, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, PerspectiveCamera, RenderTarget, Scene } from "three/webgpu";
import { mrt, output, texture, vec3, vec4 } from "three/tsl";
import { expect, it, vi } from "vitest";
import { ImpostorMesh } from "../src/impostor/mesh/index.js";
import * as surface from "../src/impostor/mesh/surface.js";
import { compileLevel } from "../src/compile.js";
import { GPU_TIMEOUT, renderer } from "./gpu.js";

vi.mock("../src/impostor/mesh/surface.js", { spy: true });

it(
  "waits for the upload queue to drain and compiles each material group",
  async () => {
    const map = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    map.needsUpdate = true;
    const materials = [new MeshBasicNodeMaterial({ map }), new MeshBasicNodeMaterial({ map })];
    const geometry = new BoxGeometry();
    geometry.clearGroups();
    geometry.addGroup(0, 18, 0);
    geometry.addGroup(18, 18, 1);
    const object = new Mesh(geometry, materials);
    const scene = new Scene();
    const target = new RenderTarget(32, 32);
    const context = { renderer, camera: new PerspectiveCamera(), scene, target, mrt: renderer.getMRT(), cubeFace: 0, mipLevel: 0 };
    let resume = () => {};
    const gate = new Promise<undefined>((resolve) => {
      resume = () => resolve(undefined);
    });
    vi.spyOn(GPUQueue.prototype, "onSubmittedWorkDone").mockImplementationOnce(() => gate);
    const upload = vi.spyOn(renderer, "initTexture");
    const original = renderer.compileAsync.bind(renderer);
    const compiled: number[][] = [];
    const compile = vi.spyOn(renderer, "compileAsync").mockImplementation((...args) => {
      compiled.push(geometry.groups.map(({ start }) => start));
      return original(...args);
    });
    const pending = compileLevel(object, context);
    try {
      await Promise.resolve();
      expect(upload).not.toHaveBeenCalled();
      expect(compile).not.toHaveBeenCalled();
      resume();
      await pending;
      expect(compiled).toEqual([[0], [18]]);
    } finally {
      resume();
      await pending;
      vi.restoreAllMocks();
      geometry.dispose();
      for (const material of materials) material.dispose();
      map.dispose();
      target.dispose();
    }
  },
  GPU_TIMEOUT,
);

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

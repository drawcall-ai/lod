/// <reference types="@webgpu/types" />
import {
  BoxGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  NodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  RGBAFormat,
  Scene,
} from "three/webgpu";
import { mrt, output, texture, vec3, vec4 } from "three/tsl";
import { expect, it, vi } from "vitest";
import { ImpostorMesh } from "../src/impostor/mesh/index.js";
import * as surface from "../src/impostor/mesh/surface.js";
import { compileLevel } from "../src/compile.js";
import { renderContext } from "../src/view.js";
import { Lod } from "../src/lod.js";
import { GPU_TIMEOUT, renderer } from "./gpu.js";

vi.mock("../src/impostor/mesh/surface.js", { spy: true });

it(
  "waits a frame only after 16 MiB of texture uploads, and compiles every draw at once",
  async () => {
    // 2048² RGBA bytes: 16 MiB each.
    const big = () => {
      const map = new DataTexture(new Uint8Array(2048 * 2048 * 4), 2048, 2048);
      map.needsUpdate = true;
      return map;
    };
    const maps = [big(), big()];
    const materials = maps.map((map) => new MeshBasicNodeMaterial({ map }));
    const geometry = new BoxGeometry();
    geometry.clearGroups();
    geometry.addGroup(0, 18, 0);
    geometry.addGroup(18, 18, 1);
    const object = new Mesh(geometry, materials);
    const scene = new Scene();
    const target = new RenderTarget(32, 32);
    const context = { renderer, camera: new PerspectiveCamera(), scene, target, mrt: renderer.getMRT(), cubeFace: 0, mipLevel: 0 };
    // What happens in order: textures uploaded, frames begun, draws compiled.
    const log: string[] = [];
    const compile = renderer.compileAsync.bind(renderer);
    vi.spyOn(renderer, "compileAsync").mockImplementation((...args) => {
      log.push(`draw ${geometry.groups.map(({ start }) => start).join()}`);
      return compile(...args);
    });
    const init = renderer.initTexture.bind(renderer);
    vi.spyOn(renderer, "initTexture").mockImplementation((texture) => {
      log.push("texture");
      init(texture);
    });
    const request = window.requestAnimationFrame.bind(window);
    let last = -1;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
      request((time) => {
        if (time !== last) log.push("frame");
        last = time;
        callback(time);
      }),
    );
    try {
      await compileLevel(object, context);
      // The first texture filled the frame; the draws do not wait for one.
      expect(log.slice(0, log.indexOf("draw 0"))).toEqual(["texture", "frame", "texture"]);
      expect(log.filter((entry) => entry.startsWith("draw"))).toEqual(["draw 0", "draw 18"]);
      await new Promise((resolve) => request(resolve));
      log.length = 0;
      await compileLevel(object, context);
      // Nothing left to upload: nothing waits.
      expect(log.slice(0, log.indexOf("draw 0"))).toEqual(["texture", "texture"]);
    } finally {
      vi.restoreAllMocks();
      geometry.dispose();
      for (const material of materials) material.dispose();
      for (const map of maps) map.dispose();
      target.dispose();
    }
  },
  GPU_TIMEOUT,
);

it(
  "builds a shader once for draws compiled together, and finishes each only once the pipeline it shares is ready",
  async () => {
    // Two materials alike build to one program, and so one pipeline; the second draw of each finds its shader built.
    const materials = [new MeshBasicNodeMaterial({ color: "teal" }), new MeshBasicNodeMaterial({ color: "teal" })];
    const geometry = new BoxGeometry();
    const scene = new Scene();
    const context = { renderer, camera: new PerspectiveCamera(), scene, target: new RenderTarget(32, 32), mrt: renderer.getMRT(), cubeFace: 0, mipLevel: 0 };
    const created = GPUDevice.prototype.createRenderPipelineAsync;
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const pipelines = vi.spyOn(GPUDevice.prototype, "createRenderPipelineAsync").mockImplementation(async function (this: GPUDevice, descriptor) {
      const pipeline = await created.call(this, descriptor);
      await held;
      return pipeline;
    });
    const builds = vi.spyOn(NodeMaterial.prototype, "setup");
    try {
      const done = new Set<number>();
      const levels = [...materials, ...materials].map((material, i) => compileLevel(new Mesh(geometry, material), context).then(() => done.add(i)));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(pipelines).toHaveBeenCalledTimes(1);
      expect(done.size).toBe(0);
      release();
      await Promise.all(levels);
      expect(builds.mock.calls.filter(([builder]) => materials.some((material) => material === builder.material))).toHaveLength(2);
    } finally {
      vi.restoreAllMocks();
      geometry.dispose();
      for (const material of materials) material.dispose();
      context.target.dispose();
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
      version: 4,
      layout: "full",
      frames: 4,
      size: 16,
      box: [-1, -1, -1, 1, 1, 1],
      halfSize: 1.5,
      maps: ["base", "normalDepth", "orm"],
      layers: [0, 1, 2].map(() => ({ format: RGBAFormat, mipmaps: [16, 8, 4].map((size) => new Uint8Array(size * size * 4)) })),
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

it(
  "precompiles an arriving caster's draws into the shadow maps the scene's level meshes draw into",
  async () => {
    renderer.shadowMap.enabled = true;
    const light = new DirectionalLight();
    light.position.set(1, 3, 2);
    light.castShadow = true;
    const ground = new Mesh(new PlaneGeometry(10, 10).rotateX(-Math.PI / 2), new MeshStandardNodeMaterial());
    ground.receiveShadow = true;
    const resident = new Mesh(new BoxGeometry(), new MeshStandardNodeMaterial());
    resident.castShadow = true;
    // An owner in the scene learns its renders: the camera's context and the shadow maps.
    const owner = new Lod([{ object: resident }]);
    const scene = new Scene().add(light, ground, owner);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 2, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const target = new RenderTarget(32, 32);
    const map = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    map.needsUpdate = true;
    // The caster's own shadow nodes (an alpha-tested map) and side select its shadow pipeline.
    const material = new MeshStandardNodeMaterial({ map, alphaTest: 0.5, shadowSide: DoubleSide });
    const arriving = new Mesh(new BoxGeometry(), material);
    arriving.castShadow = true;
    arriving.position.x = 1.5;
    const synchronous = vi.spyOn(GPUDevice.prototype, "createRenderPipeline");
    try {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.render(scene, camera);
      const context = renderContext(camera);
      if (!context) throw new Error("Expected the resident's render context");
      await compileLevel(arriving, context);
      synchronous.mockClear();
      renderer.setRenderTarget(target);
      light.shadow.needsUpdate = true;
      renderer.render(scene.add(arriving), camera);
      expect(synchronous).not.toHaveBeenCalled();
    } finally {
      synchronous.mockRestore();
      renderer.setRenderTarget(null);
      renderer.shadowMap.enabled = false;
      owner.dispose();
      for (const mesh of [ground, arriving]) mesh.geometry.dispose();
      map.dispose();
      target.dispose();
    }
  },
  GPU_TIMEOUT,
);

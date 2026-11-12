/// <reference types="@webgpu/types" />
import {
  Box3,
  BoxGeometry,
  CubeTexture,
  DataTexture,
  DirectionalLight,
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
import { ImpostorMesh } from "../../../src/impostor/mesh/index.js";
import * as surface from "../../../src/impostor/mesh/surface.js";
import { Lod } from "../../../src/lod.js";
import { compilerOf } from "../../../src/levels/compile/index.js";
import { inShadowMap } from "../../../src/levels/renderer.js";
import { GPU_TIMEOUT, renderer, eventually } from "../../renderer.js";

vi.mock("../../../src/impostor/mesh/surface.js", { spy: true });

/** A compile for its context alone: no shadow maps, no target disposed. */
const alone = { shadows: [], isDisposed: () => false };

/** A level's draws on a 32 px target, seen from a default camera. */
const contextOf = (scene = new Scene()) => ({
  camera: new PerspectiveCamera(),
  scene,
  target: new RenderTarget(32, 32),
  mrt: renderer.getMRT(),
  cubeFace: 0,
  mipLevel: 0,
  depth: 0,
});

it("rejects a render pipeline that the backend could not compile", { timeout: GPU_TIMEOUT }, async () => {
  const context = contextOf();
  const mesh = new Mesh(new BoxGeometry(), new MeshBasicNodeMaterial({ colorNode: vec3(0.443, 0.621, 0.127) }));
  const failure = new Error("test pipeline failure");
  const compile = vi.spyOn(GPUDevice.prototype, "createRenderPipelineAsync").mockRejectedValueOnce(failure);
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(compilerOf(renderer).compileAsync(mesh, context, alone)).rejects.toThrow("render pipeline compilation failed");
    expect(compile).toHaveBeenCalledOnce();
  } finally {
    vi.restoreAllMocks();
    mesh.geometry.dispose();
    mesh.material.dispose();
    context.target.dispose();
  }
});

it(
  "uploads every texture a level draws, waiting a frame after each 16 MiB, then compiles its draws",
  async () => {
    // 2048² RGBA bytes: 16 MiB. A cube of six 1024² faces: 24 MiB.
    const map = new DataTexture(new Uint8Array(2048 * 2048 * 4), 2048, 2048);
    map.needsUpdate = true;
    const face = () => new DataTexture(new Uint8Array(1024 * 1024 * 4), 1024, 1024);
    const cube = new CubeTexture([face(), face(), face(), face(), face(), face()]);
    cube.generateMipmaps = false;
    cube.needsUpdate = true;
    const held = new DataTexture(new Uint8Array(4), 1, 1);
    const materials = [new MeshBasicNodeMaterial({ map }), Object.assign(new MeshBasicNodeMaterial({ envMap: cube }), { userData: { held } })];
    const geometry = new BoxGeometry();
    geometry.clearGroups();
    geometry.addGroup(0, 18, 0);
    geometry.addGroup(18, 18, 1);
    // An impostor holds its atlases where only its nodes reach them.
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
    const object = new Group().add(new Mesh(geometry, materials), card);
    const context = contextOf();
    // What happens in order: textures uploaded, frames begun, draws compiled.
    const log: string[] = [];
    const compile = renderer.compileAsync.bind(renderer);
    vi.spyOn(renderer, "compileAsync").mockImplementation((...args) => {
      log.push("draw");
      return compile(...args);
    });
    const init = renderer.initTexture.bind(renderer);
    vi.spyOn(renderer, "initTexture").mockImplementation((texture) => {
      log.push(texture === map ? "map" : texture === cube ? "cube" : texture === held ? "held" : card.material.textures.includes(texture) ? "atlas" : "other");
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
      await compilerOf(renderer).compileAsync(object, context, alone);
      // Each upload filled the frame; the draws do not wait for one. Frames that empty the budget may follow.
      const uploaded = () => log.slice(0, log.indexOf("draw"));
      const draws = () => log.filter((entry) => entry === "draw");
      expect(uploaded()).toEqual(["map", "frame", "cube", "frame", "atlas", "atlas", "atlas"]);
      expect(draws()).toHaveLength(3);
      await new Promise((resolve) => request(resolve));
      log.length = 0;
      await compilerOf(renderer).compileAsync(object, context, alone);
      // Nothing left to upload: nothing waits.
      expect(uploaded()).toEqual(["map", "cube", "atlas", "atlas", "atlas"]);
      expect(draws()).toHaveLength(3);
    } finally {
      vi.restoreAllMocks();
      geometry.dispose();
      for (const material of materials) material.dispose();
      for (const texture of [map, cube, held]) texture.dispose();
      card.dispose();
      context.target.dispose();
    }
  },
  GPU_TIMEOUT,
);

it(
  "requests the pipelines of different draws side by side, builds a shader once for alike draws, and finishes each once its pipeline is ready",
  async () => {
    // Two materials alike build to one program, and so one pipeline; the second draw of each finds its shader built.
    const alike = [new MeshBasicNodeMaterial({ color: "teal" }), new MeshBasicNodeMaterial({ color: "teal" })];
    const other = new MeshBasicNodeMaterial({ colorNode: vec3(0, 1, 0).mul(0.5) });
    const geometry = new BoxGeometry();
    const context = contextOf();
    const created = GPUDevice.prototype.createRenderPipelineAsync;
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const pipelines = vi.spyOn(GPUDevice.prototype, "createRenderPipelineAsync").mockImplementation(async function (this: GPUDevice, descriptor) {
      const wait = first;
      first = false;
      const pipeline = await created.call(this, descriptor);
      if (wait) await held;
      return pipeline;
    });
    const builds = vi.spyOn(NodeMaterial.prototype, "setup");
    try {
      const done = new Set<number>();
      const levels = [...alike, ...alike, other].map((material, index) =>
        compilerOf(renderer)
          .compileAsync(new Mesh(geometry, material), context, alone)
          .then(() => done.add(index)),
      );
      // The other shader's pipeline is requested while the first is still being created.
      await eventually(() => expect(pipelines).toHaveBeenCalledTimes(2));
      await eventually(() => expect([...done]).toEqual([4]));
      release();
      await Promise.all(levels);
      expect(builds.mock.calls.filter(([builder]) => alike.some((material) => material === builder.material))).toHaveLength(2);
    } finally {
      release();
      vi.restoreAllMocks();
      geometry.dispose();
      for (const material of [...alike, other]) material.dispose();
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
      await Promise.all(
        object.children.map((draw) =>
          compilerOf(renderer).compileAsync(draw, { camera, scene, target, mrt: outputs, cubeFace: 0, mipLevel: 0, depth: 0 }, alone),
        ),
      );
      expect(renderer.getRenderTarget()).toBeNull();
      expect(renderer.getMRT()).toBeNull();
      expect(scene.background).toBe(background);
      const synchronous = vi.spyOn(GPUDevice.prototype, "createRenderPipeline");
      try {
        renderer.setRenderTarget(target);
        renderer.setMRT(outputs);
        grouped.visible = true;
        grouped.position.x = 0;
        const builds = vi.spyOn(NodeMaterial.prototype, "setup");
        renderer.render(scene.add(object), camera);
        expect(synchronous).not.toHaveBeenCalled();
        expect(builds).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
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
  "builds the impostor's multisampled variant, with a %s background, across async shader-stage yields",
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
      await compilerOf(renderer).compileAsync(card, { camera, scene, target, mrt: renderer.getMRT(), cubeFace: 0, mipLevel: 0, depth: 0 }, alone);
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
  "precompiles an arriving caster's draws into the shadow maps its Lod's levels draw into, before it joins",
  async () => {
    renderer.shadowMap.enabled = true;
    const light = new DirectionalLight();
    light.position.set(1, 3, 2);
    light.castShadow = true;
    const ground = new Mesh(new PlaneGeometry(10, 10).rotateX(-Math.PI / 2), new MeshStandardNodeMaterial());
    ground.receiveShadow = true;
    // The given level casts nothing: the Lod still draws into the shadow map, as the level it waits for may cast.
    const loaded = new Mesh(new BoxGeometry(), new MeshStandardNodeMaterial());
    const arriving = new Mesh(new BoxGeometry(), new MeshStandardNodeMaterial());
    arriving.castShadow = true;
    arriving.name = "arriving";
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = async () => {
      await gate;
      return arriving;
    };
    const bounds = new Box3().setFromArray([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]);
    const lod = new Lod([
      { load, maxPixels: Infinity, box: bounds },
      { object: loaded, maxPixels: 2 },
    ]);
    const scene = new Scene().add(light, ground, lod);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 2, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const target = new RenderTarget(32, 32);
    // Whether each compile of the arriving caster's draws was for a shadow map, and whether it had joined then.
    const compiles: { shadow: boolean; joined: boolean }[] = [];
    const compile = renderer.compileAsync.bind(renderer);
    vi.spyOn(renderer, "compileAsync").mockImplementation(async (...args) => {
      const [object, , drawn] = args;
      if (object.name === "arriving") compiles.push({ shadow: drawn ? inShadowMap(drawn) : false, joined: lod.levels[0]?.object !== undefined });
      await compile(...args);
    });
    const render = () => {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
    };
    try {
      render();
      render();
      release();
      await eventually(() => {
        render();
        expect(lod.levels[0]?.object).toBeDefined();
      });
      expect(compiles).toContainEqual({ shadow: true, joined: false });
      expect(compiles).toContainEqual({ shadow: false, joined: false });
    } finally {
      release();
      vi.restoreAllMocks();
      renderer.shadowMap.enabled = false;
      lod.dispose();
      for (const mesh of [ground, arriving, loaded]) mesh.geometry.dispose();
      target.dispose();
    }
  },
  GPU_TIMEOUT,
);

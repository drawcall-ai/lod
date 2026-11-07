/// <reference types="@webgpu/types" />
import {
  BoxGeometry,
  CubeTexture,
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
import { atDepth, compileLevel } from "../src/compile.js";
import { renderContext } from "../src/view.js";
import { Lod } from "../src/lod.js";
import { GPU_TIMEOUT, renderer } from "./gpu.js";

vi.mock("../src/impostor/mesh/surface.js", { spy: true });

/** A level's draws on a 32 px target, seen from a default camera. */
const contextOf = (scene = new Scene()) => ({
  renderer,
  camera: new PerspectiveCamera(),
  scene,
  target: new RenderTarget(32, 32),
  mrt: renderer.getMRT(),
  cubeFace: 0,
  mipLevel: 0,
  depth: 0,
});

it(
  "uploads every texture a level draws, waiting a frame after each 16 MiB, then compiles every draw at once",
  async () => {
    // 2048² RGBA bytes: 16 MiB. A cube of six 1024² faces: 24 MiB.
    const map = new DataTexture(new Uint8Array(2048 * 2048 * 4), 2048, 2048);
    map.needsUpdate = true;
    const face = () => new DataTexture(new Uint8Array(1024 * 1024 * 4), 1024, 1024);
    const cube = new CubeTexture([face(), face(), face(), face(), face(), face()]);
    cube.generateMipmaps = false;
    cube.needsUpdate = true;
    const kept = new DataTexture(new Uint8Array(4), 1, 1);
    const materials = [new MeshBasicNodeMaterial({ map }), Object.assign(new MeshBasicNodeMaterial({ envMap: cube }), { userData: { kept } })];
    const geometry = new BoxGeometry();
    geometry.clearGroups();
    geometry.addGroup(0, 18, 0);
    geometry.addGroup(18, 18, 1);
    // An impostor keeps its atlases where only its nodes reach them.
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
      log.push(texture === map ? "map" : texture === cube ? "cube" : texture === kept ? "kept" : card.material.textures.includes(texture) ? "atlas" : "other");
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
      // Each upload filled the frame; the draws do not wait for one. Frames that empty the budget may follow.
      const drawn = () => log.slice(0, log.lastIndexOf("draw") + 1);
      expect(drawn()).toEqual(["map", "frame", "cube", "frame", "atlas", "atlas", "atlas", "draw", "draw", "draw"]);
      await new Promise((resolve) => request(resolve));
      log.length = 0;
      await compileLevel(object, context);
      // Nothing left to upload: nothing waits.
      expect(drawn()).toEqual(["map", "cube", "atlas", "atlas", "atlas", "draw", "draw", "draw"]);
    } finally {
      vi.restoreAllMocks();
      geometry.dispose();
      for (const material of materials) material.dispose();
      for (const texture of [map, cube, kept]) texture.dispose();
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
    const pipelines = vi.spyOn(GPUDevice.prototype, "createRenderPipelineAsync").mockImplementation(async function (this: GPUDevice, descriptor) {
      const pipeline = await created.call(this, descriptor);
      await held;
      return pipeline;
    });
    const builds = vi.spyOn(NodeMaterial.prototype, "setup");
    try {
      let done = 0;
      const levels = [...alike, ...alike, other].map((material) => compileLevel(new Mesh(geometry, material), context).then(() => done++));
      // The other shader's pipeline is requested while the first is still being created.
      await vi.waitFor(() => expect(pipelines).toHaveBeenCalledTimes(2), { timeout: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(done).toBe(0);
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
        object.children.map((draw) => compileLevel(draw, { renderer, camera, scene, target, mrt: outputs, cubeFace: 0, mipLevel: 0, depth: 0 })),
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
      await compileLevel(card, { renderer, camera, scene, target, mrt: renderer.getMRT(), cubeFace: 0, mipLevel: 0, depth: 0 });
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
      // Shaders too are built ahead, the shadow map's at the depth three draws it at, inside the view's render.
      const builds = vi.spyOn(NodeMaterial.prototype, "setup");
      renderer.setRenderTarget(target);
      light.shadow.needsUpdate = true;
      renderer.render(scene.add(arriving), camera);
      expect(synchronous).not.toHaveBeenCalled();
      expect(builds).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
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

it("gives a compile's own render context alone the depth it compiles for", async () => {
  const contexts = Reflect.get(renderer, "_renderContexts");
  const get = vi.spyOn(contexts, "get");
  try {
    // The compile's own context, then one a render it starts takes, as a scene's onBeforeRender may render elsewhere.
    await atDepth(renderer, 1, async () => {
      contexts.get(null, null);
      contexts.get(null, null, 0);
    });
    expect(get.mock.calls).toEqual([
      [null, null, 1],
      [null, null, 0],
    ]);
    expect(contexts.get).toBe(get);
    await atDepth(renderer, 0, async () => expect(contexts.get).toBe(get));
    // A three whose compile takes no context as it starts fails loudly.
    expect(() => atDepth(renderer, 1, async () => {})).toThrow(/r186/);
    expect(contexts.get).toBe(get);
    // On a lost device it compiles nothing, and that is all.
    Reflect.set(renderer, "_isDeviceLost", true);
    await atDepth(renderer, 1, async () => {});
  } finally {
    Reflect.set(renderer, "_isDeviceLost", false);
    vi.restoreAllMocks();
  }
});

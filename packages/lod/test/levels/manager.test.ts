import {
  Box3,
  BoxGeometry,
  DataTexture,
  LoadingManager,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  type Camera,
} from "three/webgpu";
import { expect, it, vi } from "vitest";
import { bakeImpostor } from "../../src/impostor/bake/index.js";
import { ImpostorMesh } from "../../src/impostor/mesh/index.js";
import { Lod } from "../../src/lod.js";
import { readBytes } from "../../src/bake.js";
import { GPU_TIMEOUT, bakeRenderer, render, renderer, nextLevel, eventually } from "../renderer.js";
import { box } from "../box.js";
import { gatedBox, waitUntilIdle } from "./fixture.js";

it.each(["load", "compile"].map((waiting) => ({ waiting })))(
  "shows a coarse level of a Lod while its first fine level waits to $waiting",
  { timeout: GPU_TIMEOUT },
  async ({ waiting }) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fine = vi.fn(async () => {
      if (waiting === "load") await gate;
      const mesh = box();
      mesh.name = "fine first";
      return mesh;
    });
    const coarse = vi.fn(async () => box());
    const bounds = new Box3().setFromArray([-1, -1, -1, 1, 1, 1]);
    const levels = [
      { load: fine, maxPixels: Infinity, box: bounds },
      { load: coarse, maxPixels: 8, box: bounds },
      { object: new Object3D(), maxPixels: 1 },
    ];
    const lod = new Lod(levels);
    lod.position.z = -5;
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const scene = new Scene().add(lod);
    const compile = renderer.compileAsync.bind(renderer);
    if (waiting === "compile") {
      vi.spyOn(renderer, "compileAsync").mockImplementation(async (...args) => {
        await compile(...args);
        if (args[0].name === "fine first") await gate;
      });
    }
    try {
      // The camera asks for the fine level, but its first drawable should not await that load. A frame count would
      // flake on a software GPU, where the coarse level's compile spans many frames: wait for it, drawing meanwhile.
      await eventually(async () => {
        renderer.render(scene, camera);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(lod.levels[1]?.object).toBeDefined();
      });
      expect(fine).toHaveBeenCalledOnce();
      expect(coarse).toHaveBeenCalledOnce();
      expect(lod.levels[0]?.object).toBeUndefined();
      expect((await render(scene, camera)).some((byte) => byte > 0)).toBe(true);
      release();
      await nextLevel(lod, camera);
      expect(lod.levels[0]?.object).toBeDefined();
    } finally {
      release();
      lod.dispose();
      vi.restoreAllMocks();
    }
  },
);

it(
  "starts no finer level's load and draws nothing of a Lod until the coarsest level that draws something has loaded",
  { timeout: GPU_TIMEOUT },
  async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fine = vi.fn(async () => box());
    const coarse = vi.fn(async () => {
      await gate;
      return box();
    });
    const bounds = new Box3().setFromArray([-1, -1, -1, 1, 1, 1]);
    const levels = [
      { load: fine, maxPixels: Infinity, box: bounds },
      { load: coarse, maxPixels: 8, box: bounds },
      { object: new Object3D(), maxPixels: 1 },
    ];
    const lod = new Lod(levels);
    lod.position.z = -5;
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const scene = new Scene().add(lod);
    try {
      for (let frame = 0; frame < 5; frame++) {
        renderer.render(scene, camera);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      expect(coarse).toHaveBeenCalledOnce();
      expect(fine).not.toHaveBeenCalled();
      expect(lod.pending).toBe(true);
      expect((await render(scene, camera)).some((byte) => byte > 0)).toBe(false);
      release();
      await nextLevel(lod, camera);
      await eventually(() => {
        renderer.render(scene, camera);
        expect(fine).toHaveBeenCalledOnce();
      });
    } finally {
      release();
      lod.dispose();
    }
  },
);

it("lets a level arrive for a second camera rendering to its own target only once it compiled for that target", { timeout: GPU_TIMEOUT }, async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fine = async () => {
    await gate;
    const mesh = box();
    mesh.name = "fine";
    return mesh;
  };
  const bounds = new Box3().setFromArray([-1, -1, -1, 1, 1, 1]);
  const lod = new Lod([
    { load: fine, maxPixels: Infinity, box: bounds },
    { object: box(), maxPixels: 8 },
  ]);
  lod.position.z = -5;
  const main = new PerspectiveCamera(60, 1, 0.1, 100);
  const second = new PerspectiveCamera(60, 1, 0.1, 100);
  const target = new RenderTarget(32, 32);
  const scene = new Scene().add(lod);
  const compiled: { camera: Camera; target: unknown }[] = [];
  const compile = renderer.compileAsync.bind(renderer);
  vi.spyOn(renderer, "compileAsync").mockImplementation(async (...args) => {
    const [object, camera] = args;
    const active = renderer.getRenderTarget();
    await compile(...args);
    if (object.name === "fine") compiled.push({ camera, target: active });
  });
  const frame = () => {
    renderer.render(scene, main);
    renderer.setRenderTarget(target);
    renderer.render(scene, second);
    renderer.setRenderTarget(null);
  };
  let seen: typeof compiled = [];
  lod.addEventListener("levelschange", () => (seen = [...compiled]));
  try {
    for (let i = 0; i < 3; i++) {
      frame();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    release();
    await eventually(() => {
      frame();
      expect(lod.levels[0]?.object).toBeDefined();
    });
    expect(seen).toContainEqual({ camera: second, target });
    expect(seen).toContainEqual({ camera: main, target: null });
  } finally {
    release();
    vi.restoreAllMocks();
    target.dispose();
    lod.dispose();
  }
});

it(
  "draws the level a new camera of a Lod forces at once while the cameras before it compile in the background",
  { timeout: GPU_TIMEOUT },
  async () => {
    const data = await bakeImpostor(new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial()), bakeRenderer, { resolution: 64, layout: "full" });
    const levels = [{ object: box() }, { object: new ImpostorMesh(data) }];
    const lod = new Lod(levels);
    lod.position.z = -6;
    lod.forceLevel = 0;
    const scene = new Scene().add(lod);
    // Multisampled, as no other test here draws: three builds the impostor's pipeline for it afresh.
    const target = new RenderTarget(32, 32, { samples: 4 });
    // Each render a camera of its own, each of its own render context: the first tells the Lod its renderer, the
    // second starts compiling the loaded levels for its context in the next task.
    const draw = () => {
      renderer.setRenderTarget(target);
      renderer.render(scene, new PerspectiveCamera(60, 1, 0.1, 100));
      renderer.setRenderTarget(null);
    };
    try {
      draw();
      draw();
      await new Promise((resolve) => setTimeout(resolve, 0));
      lod.forceLevel = 1;
      draw();
      const pixels = await readBytes(renderer, target, 0);
      let covered = 0;
      for (let i = 3; i < pixels.length; i += 4) if ((pixels[i] ?? 0) > 128) covered++;
      expect(covered).toBeGreaterThan(0);
    } finally {
      target.dispose();
      lod.dispose();
    }
  },
);

it.each(["before its compile starts", "while its compile uploads textures"])(
  "compiles nothing for a render target disposed Lod",
  { timeout: GPU_TIMEOUT },
  async (when) => {
    const map = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    map.needsUpdate = true;
    const lod = new Lod([{ object: new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicNodeMaterial({ map })) }]);
    lod.position.z = -5;
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const scene = new Scene().add(lod);
    const target = new RenderTarget(32, 32, { samples: 4 });
    const targets: unknown[] = [];
    const compile = renderer.compileAsync.bind(renderer);
    vi.spyOn(renderer, "compileAsync").mockImplementation(async (...args) => {
      targets.push(renderer.getRenderTarget());
      await compile(...args);
    });
    const initTexture = renderer.initTexture.bind(renderer);
    // After the compile checked its context, before it compiles the draws.
    vi.spyOn(renderer, "initTexture").mockImplementation((texture) => {
      initTexture(texture);
      if (texture === map && when !== "before its compile starts") target.dispose();
    });
    try {
      // The first render learns the renderer; the second meets the target as a new context, which compiles the levels.
      for (let i = 0; i < 2; i++) {
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
      }
      if (when === "before its compile starts") target.dispose();
      for (let frame = 0; frame < 3; frame++) await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(targets).not.toContain(target);
    } finally {
      vi.restoreAllMocks();
      lod.dispose();
      map.dispose();
    }
  },
);

/**
 * A Lod with a deferred impostor of a box above a coarser box. The impostor is the level's to free, once the Lod lets
 * go of it (see `LodLevel.hold`); `freed` settles then. Its material is then disposed only if every copy the Lod made
 * gave its reference back.
 */
async function deferredImpostor() {
  const source = new ImpostorMesh(await bakeImpostor(box(), bakeRenderer, { frames: 4, resolution: 16 }));
  const made = Promise.resolve(source);
  let free = () => {};
  const freed = new Promise<void>((resolve) => (free = resolve));
  const hold = () => () => {
    source.dispose();
    free();
  };
  const deferred = { load: () => made, maxPixels: Infinity, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]), hold };
  const levels = [deferred, { object: box() }];
  const lod = new Lod(levels);
  lod.forceLevel = 0;
  lod.position.z = -5;
  const material = vi.spyOn(source.material, "dispose");
  return { lod, deferred, source, freed, material };
}

/** Whether `object`, the drawable a compile was asked for, holds an impostor card. */
const drawsImpostor = (object: Object3D) => object.getObjectsByProperty("isImpostorMesh", true).length > 0;

it(
  "draws the coarser level of a Lod until the finer one's compile finishes, and releases the finer one when disposed meanwhile",
  async () => {
    const { lod, deferred, source, freed, material } = await deferredImpostor();
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const scene = new Scene().add(lod);
    let finish = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let begin = () => {};
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const disposed = vi.spyOn(source.geometry, "dispose");
    const installed = vi.fn();
    lod.addEventListener("levelschange", installed);
    const original = renderer.compileAsync.bind(renderer);
    try {
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld();
      // Two renders: the first learns the renderer, the second tells the camera's context and starts the load; the
      // updates that follow are the test's own.
      for (let i = 0; i < 2; i++) renderer.render(scene, camera);
      lod.autoUpdate = false;
      await deferred.load();
      vi.spyOn(renderer, "compileAsync").mockImplementation(async (...args) => {
        if (drawsImpostor(args[0])) begin();
        await original(...args);
        await gate;
      });
      // The updates once the load has landed start the level's compile.
      lod.update(camera);
      await new Promise((resolve) => setTimeout(resolve, 0));
      lod.update(camera);
      await started;
      lod.update(camera);
      expect(installed).not.toHaveBeenCalled();
      expect(lod.levels[0]?.object).toBeUndefined();
      expect(lod.getLevelAt(0, camera)).toBe(1);
      lod.dispose();
      expect(disposed).not.toHaveBeenCalled();
      finish();
      await freed;
      expect(installed).not.toHaveBeenCalled();
      expect(drawsImpostor(lod)).toBe(false);
      expect(material).toHaveBeenCalledOnce();
    } finally {
      finish();
      vi.restoreAllMocks();
      lod.dispose();
    }
  },
  GPU_TIMEOUT,
);

it("leaves a deferred level of Lod unloaded and released when its compilation fails", { timeout: GPU_TIMEOUT }, async () => {
  const { lod, freed, material } = await deferredImpostor();
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const scene = new Scene().add(lod);
  const failure = new Error("test compile failure");
  // Its impostor meshes draw its instance attributes, which must outlive the failure.
  const slots = vi.fn();
  const compile = renderer.compileAsync.bind(renderer);
  const compileAsync = vi.spyOn(renderer, "compileAsync").mockImplementation(async (...args) => {
    const [object] = args;
    if (!drawsImpostor(object)) return compile(...args);
    if (!(object instanceof ImpostorMesh) || !object.instanceColor) throw new Error("Missing prepared impostor slots");
    object.instanceMatrix.addEventListener("dispose", slots);
    object.instanceColor.addEventListener("dispose", slots);
    throw failure;
  });
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    renderer.render(scene, camera);
    await expect(nextLevel(lod, camera)).rejects.toBe(failure);
    expect(lod.levels[0]?.object).toBeUndefined();
    expect(drawsImpostor(lod)).toBe(false);
    expect(material).not.toHaveBeenCalled();
    expect(slots).not.toHaveBeenCalled();
    expect(lod.getLevelAt(0, camera)).toBe(1);
    expect((await render(scene, camera)).some((byte) => byte > 0)).toBe(true);
    lod.dispose();
    await freed;
    expect(material).toHaveBeenCalledOnce();
  } finally {
    compileAsync.mockRestore();
    report.mockRestore();
    lod.dispose();
  }
});

it.each([false, true].map((empty) => ({ empty })))(
  "loads a Lod's level only once in sight, then draws it at once where nothing drew before (empty coarser level: $empty)",
  { timeout: GPU_TIMEOUT },
  async ({ empty }) => {
    const load = vi.fn(async () => new Mesh(new BoxGeometry(), new MeshBasicNodeMaterial()));
    const deferred = { load: load, maxPixels: Infinity, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) };
    const levels = empty ? [deferred, { object: new Object3D() }] : [deferred];
    const lod = new Lod(levels);
    lod.forceLevel = 0;
    lod.position.set(1000, 0, -5);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const scene = new Scene().add(lod);
    try {
      renderer.render(scene, camera);
      lod.update(camera);
      expect(load).not.toHaveBeenCalled();
      expect(lod.levels[0]?.object).toBeUndefined();
      lod.position.x = 0;
      lod.updateMatrixWorld();
      await nextLevel(lod, camera);
      expect(load).toHaveBeenCalledOnce();
      expect(lod.pending).toBe(false);
      expect(lod.error).toBeUndefined();
      // Nothing drew before it, so the arrival draws at once, without a fade.
      lod.update(camera);
      expect(lod.getLevelAt(0, camera)).toBe(0);
    } finally {
      vi.restoreAllMocks();
      lod.dispose();
    }
  },
);

it("runs a level's load once per Lod, a clone's included, each failing on its own", { timeout: GPU_TIMEOUT }, async () => {
  const load = vi.fn<() => Promise<Object3D>>().mockRejectedValue(undefined);
  const levels = [{ load, maxPixels: Infinity, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) }];
  const lod = new Lod(levels);
  const clone = lod.clone();
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const scene = new Scene();
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const copy of [lod, clone]) {
      copy.position.z = -5;
      scene.clear().add(copy);
      renderer.render(scene, camera);
      await expect(nextLevel(copy, camera)).rejects.toThrow("level 0 failed to load");
      expect(copy.pending).toBe(false);
    }
    expect(clone.error).not.toBe(lod.error);
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    report.mockRestore();
    lod.dispose();
    clone.dispose();
  }
});

it("loads a Lod's level in a scene whose world matrices the app updates itself", { timeout: GPU_TIMEOUT }, async () => {
  const { level, release } = gatedBox();
  const manager = new LoadingManager();
  const lod = new Lod([level, { object: box(), maxPixels: 1 }], 1, { manager });
  lod.position.z = -5;
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const scene = new Scene().add(lod);
  scene.matrixWorldAutoUpdate = false;
  scene.updateMatrixWorld();
  release();
  try {
    await waitUntilIdle(manager, () => renderer.render(scene, camera));
    expect(lod.getLevelAt(0, camera)).toBe(0);
  } finally {
    lod.dispose();
  }
});

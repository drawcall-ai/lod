import {
  Box3,
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  LoadingManager,
  Mesh,
  MeshBasicMaterial,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
} from "three/webgpu";
import { expect, it, vi } from "vitest";
import { loadOnce } from "../src/deferred.js";
import { bakeImpostor } from "../src/impostor/bake/index.js";
import { ImpostorMesh } from "../src/impostor/mesh/index.js";
import { Lod } from "../src/lod.js";
import { HANDOVER_MS } from "../src/residency.js";
import { InstancedLod } from "../src/instanced/index.js";
import { GPU_TIMEOUT, render, renderer, nextLevel } from "./gpu.js";

const box = () => new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicNodeMaterial());

/**
 * `kind` with a deferred impostor of a box above a box fallback. `freed` settles once
 * the owner has released the impostor; its material is then disposed only if every
 * copy the owner made gave its reference back.
 */
async function deferredImpostor(kind: string) {
  const source = new ImpostorMesh(await bakeImpostor(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()), { frames: 4, resolution: 16 }));
  const deferred = { load: async () => source, maxPixels: Infinity, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) };
  const levels = [deferred, { object: box() }];
  const owner = kind === "Lod" ? new Lod(levels) : new InstancedLod(levels, 1);
  owner.forceLevel = 0;
  owner.position.z = -5;
  const freed = new Promise<void>((resolve) => source.geometry.addEventListener("dispose", () => resolve()));
  const material = vi.spyOn(source.material, "dispose");
  return { owner, deferred, source, freed, material };
}

/** Whether `object`, the drawable a compile was asked for, holds an impostor card. */
const drawsImpostor = (object: Object3D) => object.getObjectsByProperty("isImpostorMesh", true).length > 0;

it.each(["Lod", "InstancedLod"])(
  "keeps %s on its fallback until compilation finishes and releases the level when disposed meanwhile",
  async (kind) => {
    const { owner, deferred, source, freed, material } = await deferredImpostor(kind);
    owner.autoUpdate = false;
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
    const disposed = vi.spyOn(source.geometry, "dispose");
    const installed = vi.fn();
    owner.addEventListener("levelschange", installed);
    const original = renderer.compileAsync.bind(renderer);
    try {
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld();
      owner.update(camera);
      renderer.render(scene, camera);
      await loadOnce(deferred.load).promise;
      vi.spyOn(renderer, "compileAsync").mockImplementation(async (...args) => {
        begin();
        await original(...args);
        await gate;
      });
      owner.update(camera);
      await started;
      owner.update(camera);
      expect(installed).not.toHaveBeenCalled();
      expect(owner.levels[0]?.object).toBeUndefined();
      if (owner instanceof InstancedLod) expect(owner.levelOf(0)).toBe(1);
      else expect(owner.levels[1]?.object?.visible).toBe(true);
      owner.dispose();
      expect(disposed).not.toHaveBeenCalled();
      finish();
      await freed;
      expect(installed).not.toHaveBeenCalled();
      expect(drawsImpostor(owner)).toBe(false);
      expect(material).toHaveBeenCalledOnce();
    } finally {
      finish();
      vi.restoreAllMocks();
      owner.dispose();
    }
  },
  GPU_TIMEOUT,
);

it.each(["Lod", "InstancedLod"])("leaves a deferred level of %s unloaded and released when its compilation fails", { timeout: GPU_TIMEOUT }, async (kind) => {
  const { owner, freed, material } = await deferredImpostor(kind);
  if (owner instanceof InstancedLod) owner.setColorAt(0, new Color("red"));
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const scene = new Scene().add(owner);
  const failure = new Error("test compile failure");
  // An InstancedLod's impostor meshes draw the Selection's shared slots, which must outlive the failure.
  const slots = vi.fn();
  const compile = renderer.compileAsync.bind(renderer);
  const compileAsync = vi.spyOn(renderer, "compileAsync").mockImplementation(async (...args) => {
    const [object] = args;
    if (!drawsImpostor(object)) return compile(...args);
    if (owner instanceof InstancedLod) {
      if (!(object instanceof ImpostorMesh) || !object.instanceColor) throw new Error("Missing prepared impostor slots");
      object.instanceMatrix.addEventListener("dispose", slots);
      object.instanceColor.addEventListener("dispose", slots);
    }
    throw failure;
  });
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    renderer.render(scene, camera);
    await expect(nextLevel(owner, camera)).rejects.toBe(failure);
    expect(owner.levels[0]?.object).toBeUndefined();
    expect(drawsImpostor(owner)).toBe(false);
    expect(material).not.toHaveBeenCalled();
    if (owner instanceof InstancedLod) {
      expect(slots).not.toHaveBeenCalled();
      expect(owner.levelOf(0)).toBe(1);
      expect((await render(scene, camera)).some((byte) => byte > 0)).toBe(true);
    }
    owner.dispose();
    await freed;
    expect(material).toHaveBeenCalledOnce();
  } finally {
    compileAsync.mockRestore();
    report.mockRestore();
    owner.dispose();
  }
});

it.each(["Lod", "InstancedLod"].flatMap((kind) => [false, true].map((empty) => ({ kind, empty }))))(
  "discovers the view for $kind before drawing (empty fallback: $empty)",
  { timeout: GPU_TIMEOUT },
  async ({ kind, empty }) => {
    const load = vi.fn(async () => new Mesh(new BoxGeometry(), new MeshBasicNodeMaterial()));
    const deferred = { load: load, maxPixels: Infinity, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) };
    const levels = empty ? [deferred, { object: new Object3D() }] : [deferred];
    const owner = kind === "Lod" ? new Lod(levels) : new InstancedLod(levels, 1);
    owner.forceLevel = 0;
    owner.position.set(1000, 0, -5);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const scene = new Scene().add(owner);
    try {
      renderer.render(scene, camera);
      owner.update(camera);
      expect(load).not.toHaveBeenCalled();
      expect(owner.levels[0]?.object).toBeUndefined();
      owner.position.x = 0;
      owner.updateMatrixWorld();
      await nextLevel(owner, camera);
      expect(load).toHaveBeenCalledOnce();
      expect(owner.pending).toBe(false);
      expect(owner.error).toBeUndefined();
      // Nothing drew before it, so the arrival draws at once, without a handover.
      owner.update(camera);
      if (owner instanceof InstancedLod) expect(owner.levelOf(0)).toBe(0);
      else expect(owner.levels[0]?.object?.visible).toBe(true);
    } finally {
      vi.restoreAllMocks();
      owner.dispose();
    }
  },
);

it.each(["Lod", "InstancedLod"])("shares a failed decode with a cloned %s without retrying", { timeout: GPU_TIMEOUT }, async (kind) => {
  const load = vi.fn<() => Promise<Object3D>>().mockRejectedValue(undefined);
  const levels = [{ load, maxPixels: Infinity, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) }];
  const owner = kind === "Lod" ? new Lod(levels) : new InstancedLod(levels, 1);
  const clone = owner.clone();
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const scene = new Scene();
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const copy of [owner, clone]) {
      copy.position.z = -5;
      scene.clear().add(copy);
      renderer.render(scene, camera);
      await expect(nextLevel(copy, camera)).rejects.toThrow("load failed");
      expect(copy.pending).toBe(false);
    }
    expect(clone.error).toBe(owner.error);
    expect(load).toHaveBeenCalledOnce();
  } finally {
    report.mockRestore();
    owner.dispose();
    clone.dispose();
  }
});

/**
 * The skill's wait for `manager`: `draw`, wait a frame, and while it is loading, `compile`, `draw` and wait a frame
 * again. Throws once an item fails.
 */
async function waitUntilIdle(manager: LoadingManager, draw: () => void, compile?: () => Promise<unknown>): Promise<void> {
  let loading = false;
  let failed: string | undefined;
  manager.onStart = () => (loading = true);
  manager.onLoad = () => (loading = false);
  manager.onError = (url) => (failed = url);
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  draw();
  await frame();
  while (loading && !failed) {
    await compile?.();
    draw();
    await frame();
  }
  if (failed) throw new Error(`${failed} failed`);
}

/** Waits as the skill does with one view of `scene`, compiling it while loading unless `compile` is false. */
const compileUntilIdle = (scene: Scene, camera: PerspectiveCamera, manager: LoadingManager, compile = true) =>
  waitUntilIdle(manager, () => renderer.render(scene, camera), compile ? () => renderer.compileAsync(scene, camera) : undefined);

/** A deferred box whose load finishes only once `release` is called. */
function gatedBox() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const load = vi.fn(async () => {
    await gate;
    return box();
  });
  return { level: { load, maxPixels: Infinity, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) }, load, release };
}

it.each(["Lod", "InstancedLod"])(
  "holds an item on %s's manager until the level the view selects has arrived and faded in",
  { timeout: GPU_TIMEOUT },
  async (kind) => {
    const { level, load, release } = gatedBox();
    // The box is about 40 px tall: the view selects the deferred source.
    const levels = [level, { object: box(), maxPixels: 1 }];
    const manager = new LoadingManager();
    const owner = kind === "Lod" ? new Lod(levels, { manager }) : new InstancedLod(levels, 1, { manager });
    owner.position.z = -5;
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const scene = new Scene().add(owner);
    let settled = false;
    const idle = compileUntilIdle(scene, camera, manager).then(() => (settled = true));
    try {
      await vi.waitFor(() => expect(load).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      release();
      await idle;
      if (owner instanceof InstancedLod) expect(owner.levelOf(0)).toBe(0);
      else expect(visibleLevels(owner)).toEqual([0]);
    } finally {
      owner.dispose();
    }
  },
);

it.each(["Lod", "InstancedLod"].flatMap((kind) => ["directional", "point"].map((light) => ({ kind, light }))))(
  "holds an item on $kind's manager until the level of a caster behind the view has arrived, lit by a $light light",
  { timeout: GPU_TIMEOUT },
  async ({ kind, light }) => {
    renderer.shadowMap.enabled = true;
    const { level, load, release } = gatedBox();
    const levels = [level, { object: box(), maxPixels: 1 }];
    const manager = new LoadingManager();
    const owner = kind === "Lod" ? new Lod(levels, { manager }) : new InstancedLod(levels, 1, { manager });
    // Behind the camera, casting onto the ground it sees.
    owner.position.z = 5;
    const lamp = light === "point" ? new PointLight(0xffffff, 100) : new DirectionalLight();
    lamp.castShadow = true;
    lamp.position.set(0, 10, 5);
    const ground = new Mesh(new PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new MeshStandardNodeMaterial());
    ground.position.y = -2;
    ground.receiveShadow = true;
    // A level mesh in view supplies the view's render context.
    const seen = new Lod([{ object: box() }], { manager });
    seen.position.z = -5;
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const scene = new Scene().add(owner, seen, lamp, ground);
    owner.traverse((node) => (node.castShadow = true));
    let settled = false;
    const idle = compileUntilIdle(scene, camera, manager, false).then(() => (settled = true));
    try {
      await vi.waitFor(() => expect(load).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      release();
      await idle;
      expect(owner.levels[0]?.object).toBeDefined();
    } finally {
      renderer.shadowMap.enabled = false;
      owner.dispose();
      seen.dispose();
    }
  },
);

it("holds a Lod's item while a camera of the current or last pass misses a level, then ends it once", { timeout: GPU_TIMEOUT }, async () => {
  const { level } = gatedBox();
  const manager = new LoadingManager();
  // The installed coarse box draws from afar; only near does the deferred source draw.
  const owner = new Lod([level, { object: box(), maxPixels: 10 }], { manager });
  owner.position.z = -50;
  const [view, thumbnail] = [new PerspectiveCamera(60, 1, 0.1, 100), new PerspectiveCamera(60, 1, 0.1, 100)];
  thumbnail.position.z = -45;
  thumbnail.updateMatrixWorld();
  const scene = new Scene().add(owner);
  try {
    // The first render shows the owner its scene; the scene's renders count from the next.
    renderer.render(scene, view);
    renderer.render(scene, view);
    await Promise.resolve();
    const end = vi.spyOn(manager, "itemEnd");
    renderer.render(scene, thumbnail);
    expect(owner.pending).toBe(true);
    // The view's next render ends the pass the thumbnail rendered in; its demand lasts one more pass.
    renderer.render(scene, view);
    expect(owner.pending).toBe(true);
    await Promise.resolve();
    expect(end).not.toHaveBeenCalled();
    renderer.render(scene, view);
    expect(owner.pending).toBe(false);
    await Promise.resolve();
    expect(end).toHaveBeenCalledOnce();
  } finally {
    owner.dispose();
  }
});

it.each(["Lod", "InstancedLod"])(
  "holds an item on %s's manager for a fresh camera facing away from every installed level",
  { timeout: GPU_TIMEOUT },
  async (kind) => {
    const { level, load, release } = gatedBox();
    const levels = [level, { object: box(), maxPixels: 1 }];
    const manager = new LoadingManager();
    const owner = kind === "Lod" ? new Lod(levels, { manager }) : new InstancedLod(levels, 1, { manager });
    owner.position.z = -5;
    // Demand follows position, not the frustum: the camera looks away from the owner.
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.rotation.y = Math.PI;
    const scene = new Scene().add(owner);
    let settled = false;
    const idle = compileUntilIdle(scene, camera, manager, false).then(() => (settled = true));
    try {
      await vi.waitFor(() => expect(load).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      release();
      await idle;
      expect(owner.levels[0]?.object).toBeDefined();
    } finally {
      owner.dispose();
    }
  },
);

type Parts = { scene: Scene; group: Group; owner: Lod };
const cases: { how: string; leave: (parts: Parts) => unknown; back: (parts: Parts) => unknown }[] = [
  { how: "removed", leave: ({ group, owner }: Parts) => group.remove(owner), back: ({ group, owner }: Parts) => group.add(owner) },
  { how: "under a removed group", leave: ({ scene, group }: Parts) => scene.remove(group), back: ({ scene, group }: Parts) => scene.add(group) },
  { how: "hidden", leave: ({ owner }: Parts) => (owner.visible = false), back: ({ owner }: Parts) => (owner.visible = true) },
  { how: "on a layer the camera does not test", leave: ({ owner }: Parts) => owner.layers.set(1), back: ({ owner }: Parts) => owner.layers.set(0) },
  { how: "not auto-updated", leave: ({ owner }: Parts) => (owner.autoUpdate = false), back: ({ owner }: Parts) => (owner.autoUpdate = true) },
];
it.each(cases)(
  "ends a held Lod's item once its scene renders a pass without it, $how, and holds it again once drawn",
  { timeout: GPU_TIMEOUT },
  async ({ leave, back }) => {
    const { level } = gatedBox();
    const manager = new LoadingManager();
    const owner = new Lod([level, { object: box(), maxPixels: 1 }], { manager });
    owner.position.z = -5;
    const group = new Group().add(owner);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const scene = new Scene().add(group);
    const start = vi.spyOn(manager, "itemStart");
    const end = vi.spyOn(manager, "itemEnd");
    try {
      renderer.render(scene, camera);
      renderer.render(scene, camera);
      await Promise.resolve();
      expect(start).toHaveBeenCalledOnce();
      leave({ scene, group, owner });
      // The pass it last updated in ends with the next render; the one after ends a pass without it.
      renderer.render(scene, camera);
      await Promise.resolve();
      expect(end).not.toHaveBeenCalled();
      renderer.render(scene, camera);
      await Promise.resolve();
      expect(end).toHaveBeenCalledOnce();
      back({ scene, group, owner });
      renderer.render(scene, camera);
      await Promise.resolve();
      expect(start).toHaveBeenCalledTimes(2);
    } finally {
      owner.dispose();
    }
  },
);

it("holds a nested Lod's items on its owner's manager until its deferred levels arrive", { timeout: GPU_TIMEOUT }, async () => {
  const { level, release } = gatedBox();
  const manager = new LoadingManager();
  const inner = new Lod([level, { object: box(), maxPixels: 1 }]);
  const outer = new Lod(
    [
      { load: async () => inner, maxPixels: Infinity, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) },
      { object: box(), maxPixels: 1 },
    ],
    { manager },
  );
  outer.position.z = -5;
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const scene = new Scene().add(outer);
  try {
    let settled = false;
    const idle = compileUntilIdle(scene, camera, manager).then(() => (settled = true));
    await vi.waitFor(() => expect(outer.levels[0]?.object).toBeDefined(), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 2 * HANDOVER_MS));
    expect(settled).toBe(false);
    release();
    await idle;
    const nested = outer.levels[0]?.object;
    if (!(nested instanceof Lod)) throw new Error("the nested level is not a Lod");
    expect(visibleLevels(outer)).toEqual([0]);
    expect(visibleLevels(nested)).toEqual([0]);
  } finally {
    outer.dispose();
  }
});

it("reports a failed level the view needs as an item error", { timeout: GPU_TIMEOUT }, async () => {
  const manager = new LoadingManager();
  const owner = new Lod([{ load: () => Promise.reject(new Error("load failed")), maxPixels: Infinity, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) }], {
    manager,
  });
  owner.position.z = -5;
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const scene = new Scene().add(owner);
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(compileUntilIdle(scene, camera, manager)).rejects.toThrow(`Lod ${owner.uuid} failed`);
  } finally {
    report.mockRestore();
    owner.dispose();
  }
});

const visibleLevels = (owner: Lod) => owner.levels.flatMap(({ object }, i) => (object?.visible ? [i] : []));

it.each(["Lod", "InstancedLod"])(
  "fails a %s that a render of a non-Scene root reaches, and loads it in a nested Scene rendered on its own",
  { timeout: GPU_TIMEOUT },
  async (kind) => {
    const make = (manager: LoadingManager) => {
      const levels = [gatedBox().level, { object: box(), maxPixels: 1 }];
      const owner = kind === "Lod" ? new Lod(levels, { manager }) : new InstancedLod(levels, 1, { manager });
      owner.position.z = -5;
      return owner;
    };
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const lone = make(new LoadingManager());
    const group = new Group().add(lone);
    const manager = new LoadingManager();
    const { level, release } = gatedBox();
    const levels = [level, { object: box(), maxPixels: 1 }];
    const nested = kind === "Lod" ? new Lod(levels, { manager }) : new InstancedLod(levels, 1, { manager });
    nested.position.z = -5;
    const inner = new Scene().add(nested);
    new Scene().add(inner);
    try {
      expect(() => renderer.render(group, camera)).not.toThrow();
      expect(lone.error?.message).toMatch(/render a Scene/);
      expect(report).toHaveBeenCalledOnce();
      release();
      await waitUntilIdle(manager, () => renderer.render(inner, camera));
      if (nested instanceof InstancedLod) expect(nested.levelOf(0)).toBe(0);
      else expect(visibleLevels(nested)).toEqual([0]);
    } finally {
      report.mockRestore();
      lone.dispose();
      nested.dispose();
    }
  },
);

it("ends an InstancedLod's item whose camera also renders another scene into a target each frame", { timeout: GPU_TIMEOUT }, async () => {
  const { level, release } = gatedBox();
  const manager = new LoadingManager();
  const owner = new InstancedLod([level, { object: box(), maxPixels: 1 }], 1, { manager });
  owner.position.z = -5;
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const scene = new Scene().add(owner);
  const other = new Scene().add(box().translateZ(-5));
  release();
  try {
    await waitUntilIdle(manager, () => {
      renderer.render(scene, camera);
      void render(other, camera, 16);
    });
    expect(owner.levelOf(0)).toBe(0);
  } finally {
    owner.dispose();
  }
});

it("loads a Lod's level in a scene whose world matrices the app updates itself", { timeout: GPU_TIMEOUT }, async () => {
  const { level, release } = gatedBox();
  const manager = new LoadingManager();
  const owner = new Lod([level, { object: box(), maxPixels: 1 }], { manager });
  owner.position.z = -5;
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const scene = new Scene().add(owner);
  scene.matrixWorldAutoUpdate = false;
  scene.updateMatrixWorld();
  release();
  try {
    await waitUntilIdle(manager, () => renderer.render(scene, camera));
    expect(visibleLevels(owner)).toEqual([0]);
  } finally {
    owner.dispose();
  }
});

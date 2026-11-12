import {
  Box3,
  DirectionalLight,
  Group,
  LoadingManager,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
} from "three/webgpu";
import { expect, it, vi } from "vitest";
import { Lod } from "../../src/lod.js";
import { GPU_TIMEOUT, render, renderer, eventually } from "../renderer.js";
import { box } from "../box.js";
import { lodOf } from "../instances.js";
import { gatedBox, waitUntilIdle } from "./fixture.js";

/** Waits as the skill does with one camera of `scene`, compiling it while loading unless `compile` is false. */
const compileUntilIdle = (scene: Scene, camera: PerspectiveCamera, manager: LoadingManager, compile = true) =>
  waitUntilIdle(manager, () => renderer.render(scene, camera), compile ? () => renderer.compileAsync(scene, camera) : undefined);

/**
 * Where a camera finds the level it needs: in front of it, compiled while loading; behind it, facing away; or behind it,
 * casting into the ground it sees under a shadow-casting light, which a level mesh in sight lights.
 */
const placements = ["in sight", "facing away", "directional shadow", "point shadow"] as const;

it.each(placements.map((placement) => ({ placement })))(
  "holds an item on Lod's manager until the level the camera needs, $placement, has arrived and faded in",
  { timeout: GPU_TIMEOUT },
  async ({ placement }) => {
    const shadow = placement.endsWith("shadow");
    renderer.shadowMap.enabled = shadow;
    const { level, load, release } = gatedBox();
    // The box is about 40 px tall: the camera needs the deferred source.
    const levels = [level, { object: box(), maxPixels: 1 }];
    const manager = new LoadingManager();
    const lod = new Lod(levels, 1, { manager });
    lod.position.z = shadow ? 5 : -5;
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    // What a camera requests follows its position, not its frustum.
    if (placement === "facing away") camera.rotation.y = Math.PI;
    const scene = new Scene().add(lod);
    const seen = new Lod([{ object: box() }], 1, { manager });
    if (shadow) {
      const lamp = placement === "point shadow" ? new PointLight(0xffffff, 100) : new DirectionalLight();
      lamp.castShadow = true;
      lamp.position.set(0, 10, 5);
      const ground = new Mesh(new PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new MeshStandardNodeMaterial());
      ground.position.y = -2;
      ground.receiveShadow = true;
      seen.position.z = -5;
      scene.add(seen, lamp, ground);
      lod.traverse((node) => (node.castShadow = true));
    }
    let settled = false;
    const idle = compileUntilIdle(scene, camera, manager, placement === "in sight").then(() => (settled = true));
    try {
      await eventually(() => expect(load).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      release();
      await idle;
      expect(lod.levels[0]?.object).toBeDefined();
      if (placement !== "in sight") return;
      expect(lod.getLevelAt(0, camera)).toBe(0);
    } finally {
      renderer.shadowMap.enabled = false;
      lod.dispose();
      seen.dispose();
    }
  },
);

it("holds a Lod's item while a camera of the current or last round misses a level, then ends it once", { timeout: GPU_TIMEOUT }, async () => {
  const { level } = gatedBox();
  const manager = new LoadingManager();
  // The installed coarse box draws from afar; only near does the deferred source draw.
  const lod = new Lod([level, { object: box(), maxPixels: 10 }], 1, { manager });
  lod.position.z = -50;
  const [main, thumbnail] = [new PerspectiveCamera(60, 1, 0.1, 100), new PerspectiveCamera(60, 1, 0.1, 100)];
  thumbnail.position.z = -45;
  thumbnail.updateMatrixWorld();
  const scene = new Scene().add(lod);
  try {
    // The main camera's renders compile the coarse box for it.
    renderer.render(scene, main);
    while (lod.pending) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      renderer.render(scene, main);
    }
    await Promise.resolve();
    const end = vi.spyOn(manager, "itemEnd");
    renderer.render(scene, thumbnail);
    expect(lod.pending).toBe(true);
    // The main camera's next render ends the round the thumbnail rendered in; its request lasts one more round.
    renderer.render(scene, main);
    expect(lod.pending).toBe(true);
    await Promise.resolve();
    expect(end).not.toHaveBeenCalled();
    renderer.render(scene, main);
    expect(lod.pending).toBe(false);
    await Promise.resolve();
    expect(end).toHaveBeenCalledOnce();
  } finally {
    lod.dispose();
  }
});

type Parts = { scene: Scene; group: Group; lod: Lod };
const cases: { how: string; leave: (parts: Parts) => unknown; back: (parts: Parts) => unknown }[] = [
  { how: "removed", leave: ({ group, lod }: Parts) => group.remove(lod), back: ({ group, lod }: Parts) => group.add(lod) },
  { how: "under a removed group", leave: ({ scene, group }: Parts) => scene.remove(group), back: ({ scene, group }: Parts) => scene.add(group) },
  { how: "hidden", leave: ({ lod }: Parts) => (lod.visible = false), back: ({ lod }: Parts) => (lod.visible = true) },
  { how: "on a layer the camera does not test", leave: ({ lod }: Parts) => lod.layers.set(1), back: ({ lod }: Parts) => lod.layers.set(0) },
  { how: "not auto-updated", leave: ({ lod }: Parts) => (lod.autoUpdate = false), back: ({ lod }: Parts) => (lod.autoUpdate = true) },
];
it.each(cases)(
  "ends a held Lod's item once its renderer renders a frame's time without it, $how, and holds it again once drawn",
  { timeout: GPU_TIMEOUT },
  async ({ leave, back }) => {
    const { level } = gatedBox();
    const manager = new LoadingManager();
    const lod = new Lod([level, { object: box(), maxPixels: 1 }], 1, { manager });
    lod.position.z = -5;
    const group = new Group().add(lod);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const scene = new Scene().add(group);
    const start = vi.spyOn(manager, "itemStart");
    const end = vi.spyOn(manager, "itemEnd");
    try {
      renderer.render(scene, camera);
      renderer.render(scene, camera);
      await Promise.resolve();
      expect(start).toHaveBeenCalledOnce();
      leave({ scene, group, lod });
      renderer.render(scene, camera);
      await Promise.resolve();
      expect(end).not.toHaveBeenCalled();
      // A look a frame later finds renders without an update.
      await eventually(() => {
        renderer.render(scene, camera);
        expect(end).toHaveBeenCalledOnce();
      }, 20);
      back({ scene, group, lod });
      renderer.render(scene, camera);
      await Promise.resolve();
      expect(start).toHaveBeenCalledTimes(2);
    } finally {
      lod.dispose();
    }
  },
);

it("reports a failed level the camera needs as an item error", { timeout: GPU_TIMEOUT }, async () => {
  const manager = new LoadingManager();
  const lod = new Lod([{ load: () => Promise.reject(new Error("load failed")), maxPixels: Infinity, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) }], 1, {
    manager,
  });
  lod.position.z = -5;
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const scene = new Scene().add(lod);
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(compileUntilIdle(scene, camera, manager)).rejects.toThrow(`Lod ${lod.uuid} failed`);
  } finally {
    report.mockRestore();
    lod.dispose();
  }
});

it(
  "fails a Lod that a render of a non-Scene root reaches, and loads it in a nested Scene rendered on its own",
  { timeout: GPU_TIMEOUT },
  async () => {
    const make = (manager: LoadingManager) => {
      const levels = [gatedBox().level, { object: box(), maxPixels: 1 }];
      const lod = new Lod(levels, 1, { manager });
      lod.position.z = -5;
      return lod;
    };
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const lone = make(new LoadingManager());
    const group = new Group().add(lone);
    const manager = new LoadingManager();
    const { level, release } = gatedBox();
    const levels = [level, { object: box(), maxPixels: 1 }];
    const nested = new Lod(levels, 1, { manager });
    nested.position.z = -5;
    const inner = new Scene().add(nested);
    new Scene().add(inner);
    try {
      // The first render learns the renderer; the second asks for the levels.
      for (let i = 0; i < 2; i++) expect(() => renderer.render(group, camera)).not.toThrow();
      expect(lone.error?.message).toMatch(/render a Scene/);
      expect(report).toHaveBeenCalledOnce();
      release();
      await waitUntilIdle(manager, () => renderer.render(inner, camera));
      expect(nested.getLevelAt(0, camera)).toBe(0);
    } finally {
      report.mockRestore();
      lone.dispose();
      nested.dispose();
    }
  },
);

it("ends a Lod's item whose camera also renders another scene into a target each frame", { timeout: GPU_TIMEOUT }, async () => {
  const { level, release } = gatedBox();
  const manager = new LoadingManager();
  const lod = lodOf([level, { object: box(), maxPixels: 1 }], 1, { manager });
  lod.position.z = -5;
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const scene = new Scene().add(lod);
  const other = new Scene().add(box().translateZ(-5));
  release();
  try {
    await waitUntilIdle(manager, () => {
      renderer.render(scene, camera);
      void render(other, camera, 16);
    });
    expect(lod.getLevelAt(0, camera)).toBe(0);
  } finally {
    lod.dispose();
  }
});

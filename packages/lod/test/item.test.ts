import { ACESFilmicToneMapping, BoxGeometry, LoadingManager, Mesh, MeshBasicNodeMaterial, NoToneMapping, PerspectiveCamera, Scene } from "three/webgpu";
import { expect, it, vi } from "vitest";
import { InstancedLod } from "../src/instanced/index.js";
import { Lod } from "../src/lod.js";
import { GPU_TIMEOUT, renderer } from "./gpu.js";

const box = () => new Mesh(new BoxGeometry(), new MeshBasicNodeMaterial());

const FRAMES = 20;

const orders: { name: string; order: (owners: Lod[]) => Lod[] }[] = [
  { name: "as added", order: (owners) => owners },
  { name: "reversed", order: (owners) => [...owners].reverse() },
  { name: "alternating", order: (owners) => [...owners.filter((_, i) => i % 2), ...owners.filter((_, i) => i % 2 === 0)] },
];

it.each(orders)(
  "keeps one scene hook for many owners over many renders, and puts the scene's own back once all are disposed $name",
  { timeout: GPU_TIMEOUT },
  async ({ order }) => {
    const own = vi.fn();
    const scene = new Scene();
    scene.onBeforeRender = own;
    const owners = Array.from({ length: 20 }, (_, i) => new Lod([{ object: box() }]).translateX(i - 10).translateZ(-20));
    scene.add(...owners);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    // Another library that wraps the hook again whenever it is not in front.
    let theirs: Scene["onBeforeRender"] | undefined;
    const wrapped = vi.fn();
    for (let frame = 0; frame < FRAMES; frame++) {
      if (scene.onBeforeRender !== theirs) {
        const previous = scene.onBeforeRender;
        theirs = function (this: Scene, ...args) {
          wrapped();
          previous.apply(this, args);
        };
        scene.onBeforeRender = theirs;
      }
      renderer.render(scene, camera);
    }
    expect(own).toHaveBeenCalledTimes(FRAMES);
    // Theirs wraps once more after ours went in front of its first; nothing wraps after that.
    expect(wrapped).toHaveBeenCalledTimes(1 + 2 * (FRAMES - 1));
    for (const owner of order(owners)) owner.dispose();
    // Theirs is in front: what lies behind it stays.
    renderer.render(scene, camera);
    expect(own).toHaveBeenCalledTimes(FRAMES + 1);
    scene.onBeforeRender = own;
    const again = new Lod([{ object: box() }]);
    scene.add(again);
    // Its first update finds the hook behind; the next, with no call since, goes in front again, and the render after
    // counts the owner in.
    for (let frame = 0; frame < 3; frame++) renderer.render(scene, camera);
    expect(scene.onBeforeRender).not.toBe(own);
    again.dispose();
    expect(scene.onBeforeRender).toBe(own);
  },
);

it("puts the scene's own hook back once its owners have left the scene", { timeout: GPU_TIMEOUT }, async () => {
  const own = vi.fn();
  const scene = new Scene();
  scene.onBeforeRender = own;
  const owner = new Lod([{ object: box() }]).translateZ(-5);
  scene.add(owner);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  try {
    renderer.render(scene, camera);
    expect(scene.onBeforeRender).not.toBe(own);
    scene.remove(owner);
    for (let frame = 0; frame < 3; frame++) renderer.render(scene, camera);
    expect(scene.onBeforeRender).toBe(own);
  } finally {
    owner.dispose();
  }
});

it.each(["Lod", "InstancedLod"])(
  "reports a failure inside three's render instead of throwing, and the next render reaches the canvas (%s)",
  { timeout: GPU_TIMEOUT },
  async (kind) => {
    const manager = new LoadingManager();
    const failed = vi.fn();
    manager.onError = failed;
    const levels = [{ object: box() }];
    const owner = kind === "Lod" ? new Lod(levels, { manager }) : new InstancedLod(levels, 1, { manager });
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

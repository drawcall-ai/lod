import { Box3, BoxGeometry, Color, Mesh, MeshBasicMaterial, MeshBasicNodeMaterial, Object3D, PerspectiveCamera, Scene } from "three/webgpu";
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
      // The arrival draws once its handover has run.
      const handedOver = performance.now() + HANDOVER_MS;
      vi.spyOn(performance, "now").mockReturnValue(handedOver);
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

import { BoxGeometry, Color, Matrix4, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { LazyImpostor } from "../src/lazy.js";
import { Lod } from "../src/lod.js";
import { InstancedLod } from "../src/instanced/index.js";
import { Wind } from "../src/wind/index.js";
import { isImpostorMesh } from "../src/three.js";
import type { Impostor } from "../src/impostor/impostor.js";
import { drawOf } from "../src/fade.js";

function atlas(): Impostor {
  return {
    version: 3,
    layout: "hemi",
    frames: 4,
    size: 16,
    box: [-1, -1, -1, 1, 1, 1],
    halfSize: 1.5,
    maps: ["base", "normalDepth", "orm"],
    layers: [0, 1, 2].map(() => [16, 8, 4].map((size) => new Uint8Array(size * size * 4))),
  };
}

const source = () => new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
function camera(): PerspectiveCamera {
  const view = new PerspectiveCamera(60, 1, 0.1, 1000);
  view.position.z = 40;
  view.updateMatrixWorld();
  return view;
}

describe("LazyImpostor", () => {
  it("recognizes a descriptor through its protocol rather than its package's constructor identity", async () => {
    const lazy = new LazyImpostor(async () => atlas(), { maxPixels: 100 });
    // A separate package copy has the same methods and own state, but a different prototype.
    Object.setPrototypeOf(lazy, Object.create(Object3D.prototype, Object.getOwnPropertyDescriptors(LazyImpostor.prototype)));
    expect(lazy instanceof LazyImpostor).toBe(false);
    const lod = new Lod([source(), lazy]);
    try {
      lod.forceLevel = 1;
      lod.update(camera());
      expect(lazy.status).toBe("loading");
      await lazy.load();
      lod.update(camera());
      expect(lazy.available).toBe(true);
      expect(lod.levels[0]?.object.visible).toBe(false);
    } finally {
      lod.dispose();
    }
    expect(lazy.status).toBe("disposed");
  });
  it("shares a single request across clones, but installs independent cards", async () => {
    const data = atlas(),
      load = vi.fn(async () => data);
    const a = new LazyImpostor(load, { maxPixels: 100 }),
      b = a.clone();
    const x = new Lod([source(), a]),
      y = new Lod([source(), b]);
    const view = camera();
    try {
      expect(load).not.toHaveBeenCalled();
      x.forceLevel = y.forceLevel = 1;
      x.update(view);
      y.update(view);
      expect(a.status).toBe("loading");
      expect(x.levels[0]?.object.visible).toBe(true);
      await Promise.all([a.load(), b.load()]);
      expect(load).toHaveBeenCalledTimes(1);
      const installed = vi.fn();
      x.addEventListener("levelschange", installed);
      x.update(view);
      y.update(view);
      x.update(view);
      expect(installed).toHaveBeenCalledTimes(1);
      expect(a.children[0]).not.toBe(b.children[0]);
      expect(x.levels[0]?.object.visible).toBe(false);
      expect(a.visible).toBe(true);
      x.dispose();
      expect(b.status).toBe("ready");
    } finally {
      x.dispose();
      y.dispose();
    }
  });

  it("keeps failures visible and fallback solid; only explicit load retries", async () => {
    const failure = new Error("decode failed");
    const load = vi.fn<() => Promise<Impostor>>().mockRejectedValueOnce(failure).mockResolvedValue(atlas());
    const lazy = new LazyImpostor(load, { maxPixels: 100 });
    const lod = new Lod([source(), lazy]);
    const errors = vi.fn(),
      report = vi.spyOn(console, "error").mockImplementation(() => {});
    lazy.addEventListener("error", errors);
    try {
      lod.forceLevel = 1;
      lod.update(camera());
      await expect(lazy.load()).rejects.toBe(failure);
      lod.update(camera());
      lod.update(camera());
      expect(lazy.status).toBe("error");
      expect(lazy.error).toBe(failure);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledTimes(1);
      expect(lod.levels[0]?.object.visible).toBe(true);
      await lazy.load();
      lod.update(camera());
      expect(load).toHaveBeenCalledTimes(2);
      expect(lazy.visible).toBe(true);
    } finally {
      lod.dispose();
      report.mockRestore();
    }
  });

  it("does not install a completed request after its last descriptor is disposed", async () => {
    let complete: ((value: Impostor) => void) | undefined;
    const lazy = new LazyImpostor(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      { maxPixels: 100 },
    );
    const pending = lazy.load();
    await Promise.resolve();
    lazy.dispose();
    if (!complete) throw new Error("request did not start");
    complete(atlas());
    await expect(pending).rejects.toThrow("disposed before loading completed");
    expect(lazy.status).toBe("disposed");
    expect(lazy.children).toHaveLength(0);
    await expect(lazy.load()).rejects.toThrow("already disposed");
  });

  it("does not request offscreen families or accept a deferred source", () => {
    const load = vi.fn(async () => atlas());
    const lazy = new LazyImpostor(load, { maxPixels: 100 });
    expect(() => new Lod([lazy])).toThrow("source level must be eager");
    expect(() => new InstancedLod([lazy], 1)).toThrow("source level must be eager");
    const lod = new Lod([source(), lazy]);
    try {
      lod.forceLevel = 1;
      lod.position.x = 10000;
      lod.updateMatrixWorld();
      lod.update(camera());
      expect(lazy.status).toBe("idle");
      expect(load).not.toHaveBeenCalled();
    } finally {
      lod.dispose();
    }
  });

  it("does not retain descriptors when a constructor rejects its thresholds", () => {
    const a = new LazyImpostor(async () => atlas(), { maxPixels: 100 });
    const b = new LazyImpostor(async () => atlas(), { maxPixels: 200 });
    expect(() => new Lod([source(), a, b])).toThrow("leaves room for the fades");
    expect(() => new InstancedLod([source(), a, b], 1)).toThrow("leaves room for the fades");
    const valid = new Lod([source(), a]);
    valid.dispose();
    expect(a.status).toBe("disposed");
    b.dispose();
  });

  it("uses logical demand before the viewport is known, even though all draw bounds start conservative", () => {
    const lazy = new LazyImpostor(async () => atlas(), { maxPixels: 100 });
    const crowd = new InstancedLod([source(), lazy, new Object3D()], 1);
    const culled = crowd.levels[2];
    if (!culled) throw new Error("missing culled level");
    culled.maxPixels = 10;
    const view = camera();
    try {
      crowd.forceLevel = 0;
      crowd.update(view);
      expect(lazy.status).toBe("idle");
      crowd.forceLevel = 2;
      crowd.update(view);
      expect(lazy.status).toBe("idle");
      crowd.forceLevel = null;
      view.position.z = 1;
      view.updateMatrixWorld();
      crowd.update(view);
      expect(lazy.status).toBe("idle");
      view.position.z = 500;
      view.updateMatrixWorld();
      crowd.update(view);
      expect(lazy.status).toBe("idle");
    } finally {
      crowd.dispose();
    }
  });

  it("rebuilds each crowd sharing a descriptor, retaining instances, thresholds and wind without repeated padding", async () => {
    const lazy = new LazyImpostor(async () => atlas(), { maxPixels: 100 });
    const a = new InstancedLod([source(), lazy], 2),
      b = new InstancedLod([source(), lazy], 1);
    const view = camera(),
      matrix = new Matrix4().makeTranslation(2, 0, 0),
      color = new Color(0.25, 0.5, 0.75);
    a.setMatrixAt(1, matrix);
    a.setColorAt(1, color);
    const wind = new Wind();
    wind.apply(a, { amplitude: 0.2 });
    wind.apply(b, { amplitude: 0.2 });
    const entry = a.levels[1];
    if (!entry) throw new Error("missing lazy entry");
    entry.maxPixels = 90;
    const event = vi.fn();
    a.addEventListener("levelschange", event);
    try {
      a.forceLevel = b.forceLevel = 1;
      a.update(view);
      b.update(view);
      const original = a.children[0];
      expect(a.levelOf(1)).toBe(0);
      await lazy.load();
      a.update(view);
      b.update(view);
      expect(a.levels[1]).toBe(entry);
      expect(entry.maxPixels).toBe(90);
      expect(a.levelOf(1)).toBe(1);
      expect(b.levelOf(0)).toBe(1);
      expect(a.children[0]).toBe(original);
      expect(a.getMatrixAt(1, new Matrix4()).equals(matrix)).toBe(true);
      expect(a.getColorAt(1, new Color()).equals(color)).toBe(true);
      const card = a.children.find(isImpostorMesh),
        other = b.children.find(isImpostorMesh);
      expect(card).toBeDefined();
      expect(other).toBeDefined();
      expect(card).not.toBe(other);
      expect(card?.material.deformNode).toBeTruthy();
      const radius = a.bounds.radius,
        draw = card && drawOf(card);
      a.update(view);
      a.update(view);
      expect(a.bounds.radius).toBe(radius);
      expect(card && drawOf(card)).toBe(draw);
      expect(event).toHaveBeenCalledTimes(1);
      a.dispose();
      expect(lazy.status).toBe("ready");
      b.update(view);
      expect(b.levelOf(0)).toBe(1);
    } finally {
      a.dispose();
      b.dispose();
    }
    expect(lazy.status).toBe("disposed");
  });
});

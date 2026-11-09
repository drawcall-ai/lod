import * as t3 from "@typegpu/three";
import { d, std, tgpu } from "typegpu";
import {
  Box3,
  BoxGeometry,
  Color,
  DirectionalLight,
  LoadingManager,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
  type Camera,
  type Object3D,
} from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drawOf } from "../../src/fade.js";
import { ARGS_BYTES } from "../../src/instanced/args.js";
import { InstancedLod } from "../../src/instanced/index.js";
import { Instances } from "../../src/instanced/meshes.js";
import { GpuInstance, PAGE, type GpuRecords } from "../../src/instanced/pages/index.js";
import { GPU_TIMEOUT, render, renderer } from "../gpu.js";

// The app's side, as a test: a GPU pass that writes records and their count, and the instance function.

const CAPACITY = 1024;
const records = t3.instancedArray(CAPACITY * 4 * 2, d.vec4u);
const counts = t3.instancedArray(4, d.u32);
const first = t3.uniform(0, d.u32);
const count = t3.uniform(0, d.u32);
const counter = t3.uniform(0, d.u32);
const shift = t3.uniform(0, d.f32);

/** Record k: a spot on a grid ahead of a camera at the origin looking down -z, moved by `shift` along x, and its hash. */
const emit = t3
  .toTSL(() => {
    "use gpu";
    const i = t3.instanceIndex.$;
    if (i >= count.$) return;
    const k = first.$ + i;
    const position = d.vec3f(d.f32(k % 8) * 3 - 10.5 + shift.$, 0, -(5 + d.f32(std.intdiv(k, 8)) * 2));
    records.$[k * 2] = d.vec4u(std.bitcastF32toU32(position), (k + 1) * 2654435761);
    records.$[k * 2 + 1] = d.vec4u(0);
    if (i === 0) counts.$[counter.$] = count.$;
  })
  .compute(CAPACITY);

const place = tgpu.fn([d.vec4u, d.vec4u], GpuInstance)((spot) => {
  "use gpu";
  const p = std.bitcastU32toF32(spot.xyz);
  const hash = spot.w;
  const s = 1 + d.f32(hash % 4) * 0.25;
  return GpuInstance({
    matrix: d.mat4x4f(s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, p.x, p.y, p.z, 1),
    color: d.vec3f(d.f32(hash % 3) * 0.5, 1, 0.5),
    keep: d.f32(hash % 1024) / 1024,
  });
});

/** `place` for the records whose hash picks the first of three variants; the others make no instance. */
const firstVariant = tgpu.fn([d.vec4u, d.vec4u], GpuInstance)((spot, extra) => {
  "use gpu";
  const instance = place(spot, extra);
  return GpuInstance({ matrix: instance.matrix, color: instance.color, keep: std.select(instance.keep, 1, std.intdiv(spot.w, 1024) % 3 !== 0) });
});

/** Whether record `k`'s hash picks the first variant. */
const picked = (k: number) => Math.floor((Math.imul(k + 1, 2654435761) >>> 0) / 1024) % 3 === 0;

/** Records `from` to `from + n` as the CPU sees them: what `emit` and `place` make of them, or of those `only` takes. */
function cpuChunk(from: number, n: number, only = (_k: number) => true) {
  const matrices: number[] = [];
  const colors: number[] = [];
  const keeps: number[] = [];
  for (let k = from; k < from + n; k++) {
    if (!only(k)) continue;
    const hash = Math.imul(k + 1, 2654435761) >>> 0;
    const s = 1 + (hash % 4) * 0.25;
    matrices.push(...new Matrix4().makeScale(s, s, s).setPosition((k % 8) * 3 - 10.5, 0, -(5 + Math.floor(k / 8) * 2)).elements);
    colors.push((hash % 3) * 0.5, 1, 0.5);
    keeps.push((hash % 1024) / 1024);
  }
  return { matrices, colors, keeps };
}

/** Write records `from` to `from + n`, moved by `by`, and their count into counter `index`, on the GPU. */
function produce(from: number, n: number, index: number, by = 0): void {
  first.node.value = from;
  count.node.value = n;
  counter.node.value = index;
  shift.node.value = by;
  void renderer.compute(emit);
}

/** Every record's origin lies in this box. */
const everywhere = new Box3(new Vector3(-11, 0, -600), new Vector3(11, 0, -4));
const box = () => new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
const read = (attribute: Parameters<typeof renderer.getArrayBufferAsync>[0]) => renderer.getArrayBufferAsync(attribute);

function crowd(gpuRecords?: Partial<GpuRecords>): InstancedLod {
  const options = gpuRecords && { gpuRecords: { instance: place, records: records.node.value, counters: counts.node.value, capacity: CAPACITY, scales: [1, 1.75], ...gpuRecords } as const };
  const lod = new InstancedLod([{ object: box() }, { object: box() }], options);
  lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 6][i] ?? level.maxPixels));
  return lod;
}

/** Per level's draw, what `camera`'s slots hold: each instance's place, scale, colour and fade. */
async function drawn(lod: InstancedLod, camera: Camera): Promise<string[][]> {
  const levels = lod.children.filter((child) => child instanceof Instances);
  const draws = levels.map((mesh, i) => ({ mesh, offset: i * ARGS_BYTES }));
  return Promise.all(
    draws.map(async ({ mesh, offset }) => {
      const draw = drawOf(mesh);
      if (draw?.kind !== "instances" || !draw.slots) throw new Error("not a level mesh");
      const { indices, fades, args } = draw.slots(camera);
      const words = new Uint32Array(await read(args.attribute));
      const at = (args.offset + offset) / 4;
      const total = words[at + 1] ?? 0;
      const start = words[at + 4] ?? 0;
      const slots = new Uint32Array(await read(indices));
      const signed = new Float32Array(await read(fades));
      const matrices = new Float32Array(await read(mesh.instanceMatrix));
      const colors = new Float32Array(await read(mesh.instanceColor));
      return Array.from({ length: total }, (_, k) => {
        const i = slots[start + k] ?? 0;
        const m = matrices.subarray(i * 16, i * 16 + 16);
        return `${m[12]},${m[14]} x${m[0]} #${new Color().fromArray(colors, i * 4).getHexString()} ${(signed[start + k] ?? 0).toFixed(4)}`;
      }).sort();
    }),
  );
}

/** The places of the instances drawn, each once: a fade draws one in two levels. */
const distinct = (draws: string[][]) => new Set(draws.flat().map((slot) => slot.split(" ")[0] ?? ""));

const camera = new PerspectiveCamera(60, 1, 0.1, 1e4);
/** Sees every record from above. */
const above = new PerspectiveCamera(60, 1, 1, 1e4);
above.position.set(0, 800, -260);
above.lookAt(0, 0, -260);
above.updateMatrixWorld();

/** Render `lod`, with `others`, from `view` twice, so that it selects and takes in its chunks. */
async function frames(lod: InstancedLod, view = camera, ...others: Object3D[]): Promise<void> {
  const scene = new Scene().add(lod, ...others);
  for (let i = 0; i < 2; i++) await render(scene, view);
}

/** A sun whose shadow map covers every record, and ground to receive it. */
function sunlit(): { sun: DirectionalLight; others: Object3D[]; dispose: () => void } {
  const sun = new DirectionalLight();
  sun.position.set(0, 100, -130);
  sun.target.position.set(0, 0, -130);
  sun.castShadow = true;
  sun.shadow.mapSize.set(256, 256);
  Object.assign(sun.shadow.camera, { left: -140, right: 140, top: 140, bottom: -140, near: 1, far: 200 });
  sun.shadow.camera.updateProjectionMatrix();
  const ground = new Mesh(new PlaneGeometry(300, 300).rotateX(-Math.PI / 2), new MeshStandardMaterial());
  ground.position.set(0, -2, -130);
  ground.receiveShadow = true;
  const dispose = () => {
    sun.dispose();
    ground.geometry.dispose();
    ground.material.dispose();
  };
  return { sun, others: [sun, sun.target, ground], dispose };
}

afterEach(() => vi.restoreAllMocks());

describe("GPU chunks", { timeout: GPU_TIMEOUT }, () => {
  it("draw, thin, scale and cast the same instances as the same records given from the CPU", async () => {
    const cpu = crowd();
    const gpu = crowd({});
    for (const lod of [cpu, gpu]) {
      lod.range = { camera, radius: 160, ramp: 120, scaleSurvivors: true };
      lod.traverse((node) => (node.castShadow = true));
    }
    const { sun, others, dispose } = sunlit();
    renderer.shadowMap.enabled = true;
    // Two chunks, the first over several pages.
    const parts = [
      [0, 700],
      [CAPACITY, 300],
    ] as const;
    parts.forEach(([from, n], i) => {
      cpu.addChunk(cpuChunk(from, n));
      produce(from, n, i);
      gpu.addGpuChunk({ box: everywhere, first: from, counter: i });
    });
    try {
      await frames(cpu, camera, ...others);
      await frames(gpu, camera, ...others);
      const expected = await drawn(cpu, camera);
      // Both levels, thinned.
      expect(expected.map((slots) => slots.length > 0)).toEqual([true, true]);
      expect(expected[0]?.length).toBeLessThan(1000);
      expect(await drawn(gpu, camera)).toEqual(expected);
      const cast = await drawn(cpu, sun.shadow.camera);
      expect(cast.flat().length).toBeGreaterThan(0);
      expect(await drawn(gpu, sun.shadow.camera)).toEqual(cast);
    } finally {
      renderer.shadowMap.enabled = false;
      cpu.dispose();
      gpu.dispose();
      dispose();
    }
  });

  it("give pages only to the instances of records whose keep ratio is below 1, packed into as few pages as they fill", async () => {
    // 235 of the first chunk's 700 records pick the first variant, 99 of the second's 300: a page each, where all
    // records would take five.
    const cpu = crowd();
    const gpu = crowd({ instance: firstVariant, chunks: 2, instances: PAGE });
    const parts = [
      [0, 700],
      [CAPACITY, 300],
    ] as const;
    parts.forEach(([from, n], i) => {
      cpu.addChunk(cpuChunk(from, n, picked));
      produce(from, n, i);
      gpu.addGpuChunk({ box: everywhere, first: from, counter: i });
    });
    try {
      await frames(cpu, above);
      await frames(gpu, above);
      const expected = await drawn(cpu, above);
      expect(distinct(expected).size).toBe(235 + 99);
      expect(await drawn(gpu, above)).toEqual(expected);
    } finally {
      cpu.dispose();
      gpu.dispose();
    }
  });

  it("give a chunk replacing another in one frame its slot and pages, never the levels their instances showed", async () => {
    // The coarse level never loads: an instance that selects it keeps the level it showed, or draws nothing.
    const bounds = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
    const gpuRecords = { instance: place, records: records.node.value, counters: counts.node.value, capacity: CAPACITY, scales: [1, 1.75] as const };
    const lod = new InstancedLod([{ object: box() }, { load: () => new Promise<Mesh>(() => {}), maxPixels: 6, box: bounds }], { gpuRecords });
    // Sees all eight records of the first row.
    const view = new PerspectiveCamera(60, 1, 0.1, 1e4);
    view.position.z = 15;
    view.updateMatrixWorld();
    const scene = new Scene().add(lod);
    try {
      produce(0, 8, 0);
      const near = lod.addGpuChunk({ box: everywhere, first: 0, counter: 0 });
      for (let i = 0; i < 2; i++) await render(scene, view);
      expect(distinct(await drawn(lod, view)).size).toBe(8);
      // From afar, the same records again as a new chunk: too small for the source, which they never showed.
      lod.removeGpuChunk(near);
      expect(lod.addGpuChunk({ box: everywhere, first: 0, counter: 0 }).slot).toBe(near.slot);
      view.position.z = 3000;
      view.updateMatrixWorld();
      for (let i = 0; i < 2; i++) await render(scene, view);
      expect((await drawn(lod, view)).flat()).toEqual([]);
    } finally {
      lod.dispose();
    }
  });

  it("refuse a crowd without levels and the API of instance indices", () => {
    const gpuRecords = { instance: place, records: records.node.value, counters: counts.node.value, capacity: CAPACITY, scales: [1, 1.75] as const };
    expect(() => new InstancedLod([], { gpuRecords })).toThrow("needs its levels from the start");
    const lod = crowd({});
    try {
      expect(() => lod.setMatrixAt(0, new Matrix4())).toThrow("GPU chunks, whose instances have no index");
      expect(() => lod.levelOf(0)).toThrow("GPU chunks, whose instances have no index");
      expect(() => lod.addChunk({ matrices: new Matrix4().elements })).toThrow("GPU chunks, whose instances have no index");
    } finally {
      lod.dispose();
    }
  });

  it("take a chunk in during the first render after it is added, seen or not, so its records can be reused at once", async () => {
    const lod = crowd({});
    const away = new PerspectiveCamera(60, 1, 0.1, 1e4);
    away.rotation.y = Math.PI;
    away.updateMatrixWorld();
    const scene = new Scene().add(lod);
    try {
      produce(0, 300, 0);
      lod.addGpuChunk({ box: everywhere, first: 0, counter: 0 });
      await render(scene, away);
      // The same records and counter, overwritten for the next chunk, moved by a quarter along x.
      produce(0, 200, 0, 0.25);
      lod.addGpuChunk({ box: everywhere, first: 0, counter: 0 });
      await render(scene, away);
      // Overwritten again: what is drawn stays.
      produce(0, 50, 0, 0.5);
      await frames(lod, above);
      // x's fraction: 0.5 for the first chunk's records, 0.75 for the second's, 0 for the last write's.
      const xs = [...distinct(await drawn(lod, above))].map((spot) => {
        const x = Number(spot.split(",")[0]);
        return x - Math.floor(x);
      });
      expect(xs.filter((x) => x === 0.5).length).toBe(300);
      expect(xs.filter((x) => x === 0.75).length).toBe(200);
      expect(xs.length).toBe(500);
    } finally {
      lod.dispose();
    }
  });

  it("clamp a chunk the pool lacks pages for until it is removed, reporting it, and take back removed chunks' pages", async () => {
    const lod = crowd({ chunks: 2, instances: 2 * PAGE });
    const { manager, items } = watched();
    lod.manager = manager;
    const total = async () => distinct(await drawn(lod, above)).size;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    produce(0, 600, 0);
    produce(CAPACITY, 300, 1);
    const a = lod.addGpuChunk({ box: everywhere, first: 0, counter: 0 });
    try {
      await frames(lod, above);
      // 3 pages for the first, the last one for the second, a frame later.
      const b = lod.addGpuChunk({ box: everywhere, first: CAPACITY, counter: 1 });
      await frames(lod, above);
      expect(await total()).toBe(600 + PAGE);
      expect(await until(new Scene().add(lod), () => items.failed.length > 0)).toBe(true);
      expect(lod.error?.message).toContain("1 GPU chunk lack pages, holding 1 of the 2 pages they need: raise gpuRecords.instances (the pool has 4 pages)");
      expect(logged).toHaveBeenCalled();
      // Pages freed later do not complete it.
      lod.removeGpuChunk(a);
      await frames(lod, above);
      expect(await total()).toBe(PAGE);
      // Every page is back: a chunk needing all of them gets them.
      lod.removeGpuChunk(b);
      produce(CAPACITY, 4 * PAGE, 2);
      lod.addGpuChunk({ box: everywhere, first: CAPACITY, counter: 2 });
      await frames(lod, above);
      expect(await total()).toBe(4 * PAGE);
    } finally {
      lod.dispose();
    }
  });

  it("read nothing back while chunks come and go and views move, and only once they rest", async () => {
    const lod = crowd({});
    const readback = vi.spyOn(GPUBuffer.prototype, "mapAsync");
    const scene = new Scene().add(lod);
    try {
      for (let i = 0; i < 4; i++) {
        produce(i * CAPACITY, 500, i);
        const chunk = lod.addGpuChunk({ box: everywhere, first: i * CAPACITY, counter: i });
        camera.position.x = i;
        camera.updateMatrixWorld();
        renderer.render(scene, camera);
        if (i % 2 === 1) lod.removeGpuChunk(chunk);
      }
      renderer.render(scene, camera);
      expect(readback).not.toHaveBeenCalled();
      for (let i = 0; i < 8; i++) renderer.render(scene, camera);
      expect(readback).toHaveBeenCalled();
    } finally {
      readback.mockRestore();
      camera.position.set(0, 0, 0);
      camera.updateMatrixWorld();
      lod.dispose();
    }
  });

  /** A manager that counts the items open and keeps those that failed. */
  function watched() {
    const manager = new LoadingManager();
    const items = { open: 0, started: 0, failed: [] as string[] };
    const { itemStart, itemEnd, itemError } = manager;
    manager.itemStart = (url) => {
      items.open++;
      items.started++;
      itemStart.call(manager, url);
    };
    manager.itemEnd = (url) => {
      items.open--;
      itemEnd.call(manager, url);
    };
    manager.itemError = (url) => {
      items.failed.push(url);
      itemError.call(manager, url);
    };
    return { manager, items };
  }

  /** Renders `scene` until `done`, for ten seconds at most (levels compile meanwhile), and whether it came to be. */
  async function until(scene: Scene, done: () => boolean): Promise<boolean> {
    const end = performance.now() + 10_000;
    while (performance.now() < end && !done()) {
      // On the canvas: a target of its own for each render would compile the levels for it again.
      renderer.render(scene, camera);
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    return done();
  }

  it("hold their item from a chunk's change until the GPU shows it taken in", async () => {
    const lod = crowd({});
    const { manager, items } = watched();
    lod.manager = manager;
    const scene = new Scene().add(lod);
    try {
      produce(0, 300, 0);
      const chunk = lod.addGpuChunk({ box: everywhere, first: 0, counter: 0 });
      await Promise.resolve();
      expect(items.open).toBe(1);
      expect(await until(scene, () => items.open === 0)).toBe(true);
      // A chunk taking its slot over in one frame: its own generation must reach the GPU's state.
      lod.removeGpuChunk(chunk);
      const again = lod.addGpuChunk({ box: everywhere, first: 0, counter: 0 });
      expect(again.slot).toBe(chunk.slot);
      await Promise.resolve();
      expect(items.open).toBe(1);
      expect(await until(scene, () => items.open === 0)).toBe(true);
      lod.removeGpuChunk(again);
      await Promise.resolve();
      expect(items.open).toBe(1);
      expect(await until(scene, () => items.open === 0)).toBe(true);
      expect(lod.error).toBeUndefined();
      expect(items.failed).toEqual([]);
    } finally {
      lod.dispose();
    }
  });

  it("report a chunk the pool lacks pages for as their error, on the manager", async () => {
    const lod = crowd({ chunks: 1, instances: PAGE });
    const { manager, items } = watched();
    lod.manager = manager;
    const errors: Error[] = [];
    lod.addEventListener("levelserror", ({ error }) => errors.push(error));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const scene = new Scene().add(lod);
    try {
      produce(0, 3 * PAGE, 0);
      lod.addGpuChunk({ box: everywhere, first: 0, counter: 0 });
      expect(await until(scene, () => lod.error !== undefined)).toBe(true);
      expect(lod.error?.message).toContain("lack pages");
      expect(errors).toEqual([lod.error]);
      expect(log).toHaveBeenCalledWith(lod.error);
      await Promise.resolve();
      expect(items.failed.length).toBe(1);
      expect(items.open).toBe(0);
    } finally {
      log.mockRestore();
      lod.dispose();
    }
  });
});

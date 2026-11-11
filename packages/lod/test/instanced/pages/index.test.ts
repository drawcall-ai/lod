import { Color, LoadingManager, PerspectiveCamera, Scene, type BufferAttribute, type Camera, type Object3D } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LodGpu } from "../../../src/gpu.js";
import { InstancedLod } from "../../../src/instanced/index.js";
import { PAGE } from "../../../src/instanced/pages/workgroup.js";
import { DRAW_BYTES } from "../../../src/instanced/rows.js";
import { fadeSourceOf } from "../../../src/levels/fade.js";
import { isMesh } from "../../../src/three.js";
import { GPU_TIMEOUT, render, renderer } from "../../renderer.js";
import { drawnSlots } from "../../instances.js";
import { CAPACITY, camera, cpuChunk, gpuChunk, instancedLod, picked, produce } from "./fixture.js";

const read = (attribute: BufferAttribute) => renderer.getArrayBufferAsync(attribute);

/** A LodGpu whose pool has 5 pages: room for 512 instances in 3 chunks. */
const small = () => new LodGpu(renderer, { maxInstanceCount: 2 * PAGE, maxChunkCount: 3 });

/** Per level's draw, what `camera`'s lists hold: each instance's spot, scale, colour and fade. */
async function drawn(lod: InstancedLod, camera: Camera): Promise<string[][]> {
  const meshes = lod.children.filter(isMesh).filter((mesh) => fadeSourceOf(mesh) !== undefined);
  return Promise.all(
    meshes.map(async (mesh, index) => {
      const source = fadeSourceOf(mesh);
      if (source?.kind !== "instances" || !source.level) throw new Error("not a level mesh");
      const { indices, fades, args } = drawnSlots(mesh, camera);
      const words = new Uint32Array(await read(args.attribute));
      const at = (args.offset + index * DRAW_BYTES) / 4;
      const count = words[at + 1] ?? 0;
      const start = words[at + 4] ?? 0;
      const listed = new Uint32Array(await read(indices));
      const signed = new Float32Array(await read(fades));
      const floats = new Float32Array(await read(source.level.instances.matrices));
      const tints = new Float32Array(await read(source.level.instances.colors));
      return Array.from({ length: count }, (_, k) => {
        const i = listed[start + k] ?? 0;
        const m = floats.subarray(i * 16, i * 16 + 16);
        return `${m[12]},${m[14]} x${m[0]} #${new Color().fromArray(tints, i * 4).getHexString()} ${(signed[start + k] ?? 0).toFixed(4)}`;
      }).sort();
    }),
  );
}

/** The spots of the instances drawn, each once: a fade draws one in two levels. */
const distinct = (draws: string[][]) => new Set(draws.flat().map((slot) => slot.split(" ")[0] ?? ""));

/** Sees every spot from above. */
const above = new PerspectiveCamera(60, 1, 1, 1e4);
above.position.set(0, 800, -260);
above.lookAt(0, 0, -260);
above.updateMatrixWorld();

/** Render `lod`, with `others`, from `camera` twice, so that it takes its chunks in and sorts them. */
async function frames(lod: InstancedLod, from = camera, ...others: Object3D[]): Promise<void> {
  const scene = new Scene().add(lod, ...others);
  for (let i = 0; i < 2; i++) await render(scene, from);
}

/** A manager that counts the items open and those that failed. */
function counted() {
  const manager = new LoadingManager();
  const items = { open: 0, failed: [] as string[] };
  const { itemStart, itemEnd, itemError } = manager;
  manager.itemStart = (url) => {
    items.open++;
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

/** Renders `scene` until `done`, levels compiling meanwhile: the test's timeout catches what never comes to be. */
async function until(scene: Scene, done: () => boolean): Promise<void> {
  while (!done()) {
    // On the canvas: a target of its own for each render would compile the levels for it again.
    renderer.render(scene, camera);
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
}

afterEach(() => vi.restoreAllMocks());

describe("a LodGpu's page pool", { timeout: GPU_TIMEOUT }, () => {
  it("draws, thins and scales the instances an app's compute pass wrote and counted as it does the same instances from the CPU", async () => {
    const cpu = instancedLod();
    const gpu = instancedLod();
    for (const lod of [cpu, gpu]) lod.cullDistance = { camera, near: 40, far: 160, scaleSurvivors: true };
    try {
      // Two chunks, the first over several pages, from the same buffers: the first is read before the second is written.
      produce(0, 3 * PAGE, 0);
      gpu.addChunk(gpuChunk(3 * PAGE, 0));
      await frames(gpu);
      produce(CAPACITY, 300, 1);
      gpu.addChunk(gpuChunk(300, 1));
      await frames(gpu);
      cpu.addChunk(cpuChunk(0, 3 * PAGE));
      cpu.addChunk(cpuChunk(CAPACITY, 300));
      await frames(cpu);
      const expected = await drawn(cpu, camera);
      // Both levels, thinned.
      expect(expected.map((slots) => slots.length > 0)).toEqual([true, true]);
      expect(distinct(expected).size).toBeLessThan(PAGE + 100);
      expect(await drawn(gpu, camera)).toEqual(expected);
    } finally {
      cpu.dispose();
      gpu.dispose();
    }
  });

  it("packs only the instances at a scale above 0 into pages, as few as they fill", async () => {
    // Three chunks of 512 spots, a third at scale 0 each: a page each, where every spot would need two of the five.
    const pool = small();
    const lod = instancedLod(pool);
    const report = vi.spyOn(console, "error");
    try {
      for (let i = 0; i < 3; i++) {
        produce(i * 2 * PAGE, 2 * PAGE, 0, { write: 1 });
        lod.addChunk(gpuChunk(2 * PAGE, "in place"));
        await frames(lod, above);
      }
      const spots = Array.from({ length: 6 * PAGE }, (_, k) => k).filter(picked);
      expect(distinct(await drawn(lod, above)).size).toBe(spots.length);
      await until(new Scene().add(lod), () => !lod.pending);
      expect(lod.error).toBeUndefined();
      expect(report).not.toHaveBeenCalled();
    } finally {
      lod.dispose();
      pool.dispose();
    }
  });

  it("reads a GPU chunk once, in the first render after it is added, seen or not, so the app may overwrite its buffers then", async () => {
    const lod = instancedLod();
    const away = new PerspectiveCamera(60, 1, 0.1, 1e4);
    away.rotation.y = Math.PI;
    away.updateMatrixWorld();
    const scene = new Scene().add(lod);
    try {
      produce(0, 300, 0);
      lod.addChunk(gpuChunk(300, 0));
      await render(scene, away);
      // The same buffers and counter, overwritten for the next chunk, moved by a quarter along x.
      produce(0, 200, 0, { by: 0.25 });
      lod.addChunk(gpuChunk(200, 0));
      await render(scene, away);
      // Overwritten again: what is drawn stays.
      produce(0, 50, 0, { by: 0.5 });
      await frames(lod, above);
      // x's fraction: 0.5 for the first chunk's spots, 0.75 for the second's.
      const xs = [...distinct(await drawn(lod, above))].map((place) => {
        const x = Number(place.split(",")[0]);
        return x - Math.floor(x);
      });
      expect(xs.filter((x) => x === 0.5).length).toBe(100);
      expect(xs.filter((x) => x === 0.75).length).toBe(67);
      expect(xs.length).toBe(167);
    } finally {
      lod.dispose();
    }
  });

  it("clamps GPU chunks it lacks pages for until they are removed, reporting an error that tells the app to raise maxInstanceCount", async () => {
    const pool = small();
    const lod = instancedLod(pool);
    const { manager, items } = counted();
    lod.manager = manager;
    const errors: Error[] = [];
    lod.addEventListener("levelserror", ({ error }) => errors.push(error));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const scene = new Scene().add(lod);
    try {
      // Every spot, 512 a chunk: two pages each, six of the five there are.
      const chunks = [0, 1, 2].map((i) => {
        produce(i * 2 * PAGE, 2 * PAGE, 0, { write: 2 });
        const chunk = lod.addChunk(gpuChunk(2 * PAGE, "in place"));
        renderer.render(scene, camera);
        return chunk;
      });
      await until(scene, () => lod.error !== undefined);
      expect(lod.error?.message).toContain("lack pages");
      expect(lod.error?.message).toContain("raise LodGpu's maxInstanceCount (its pool has 5 pages of 256)");
      expect(errors).toEqual([lod.error]);
      expect(log).toHaveBeenCalledWith(lod.error);
      await Promise.resolve();
      expect(items.failed.length).toBe(1);
      expect(items.open).toBe(0);
      for (const chunk of chunks) lod.removeChunk(chunk);
    } finally {
      lod.dispose();
      pool.dispose();
    }
  });

  it("holds an InstancedLod's item from a chunk's change until the GPU shows it taken in, a slot reused in one frame included", async () => {
    const lod = instancedLod();
    const { manager, items } = counted();
    lod.manager = manager;
    const scene = new Scene().add(lod);
    try {
      produce(0, 300, 0);
      const chunk = lod.addChunk(gpuChunk(300, 0));
      await Promise.resolve();
      expect(items.open).toBe(1);
      await until(scene, () => items.open === 0);
      // A chunk taking its slot over in one frame: its own generation must reach the GPU's state.
      lod.removeChunk(chunk);
      const again = lod.addChunk(gpuChunk(300, 0));
      await Promise.resolve();
      expect(items.open).toBe(1);
      await until(scene, () => items.open === 0);
      lod.removeChunk(again);
      await Promise.resolve();
      expect(items.open).toBe(1);
      await until(scene, () => items.open === 0);
      expect(lod.error).toBeUndefined();
      expect(items.failed).toEqual([]);
    } finally {
      lod.dispose();
    }
  });

  it("takes in chunks of two LodGpus in one render, each pool holding its own instances", async () => {
    // A small LodGpu's pool and a large one's, then each alone. The picked spots: 171 of the small one's 512, 256 of the
    // large one's 768.
    const pools = [small(), small()];
    const make = (pool: LodGpu) => [
      { lod: instancedLod(pool), chunk: () => cpuChunk(0, 2 * PAGE) },
      { lod: instancedLod(), chunk: () => cpuChunk(2 * PAGE, 3 * PAGE) },
    ];
    const [first, second] = pools;
    if (!first || !second) throw new Error("two LodGpus");
    const together = make(first);
    const alone = make(second);
    try {
      for (const { lod, chunk } of [...together, ...alone]) lod.addChunk(chunk());
      const [small, large] = together.map(({ lod }) => lod);
      if (!small || !large) throw new Error("two InstancedLods");
      await frames(small, above, large);
      for (const { lod } of alone) await frames(lod, above);
      for (const [i, { lod }] of together.entries()) {
        const reference = await drawn(alone[i]?.lod ?? lod, above);
        expect(distinct(reference).size).toBe(i === 0 ? 171 : 256);
        expect(await drawn(lod, above)).toEqual(reference);
      }
    } finally {
      for (const { lod } of [...together, ...alone]) lod.dispose();
      for (const pool of pools) pool.dispose();
    }
  });
});

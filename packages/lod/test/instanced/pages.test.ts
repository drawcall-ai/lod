import * as t3 from "@typegpu/three";
import { d, std, tgpu } from "typegpu";
import { Box3, BoxGeometry, Color, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3, type Camera } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drawOf } from "../../src/fade.js";
import { ARGS_BYTES } from "../../src/instanced/args.js";
import { ContactMesh } from "../../src/instanced/contact.js";
import { InstancedLod } from "../../src/instanced/index.js";
import { Instances } from "../../src/instanced/meshes.js";
import { GpuInstance, PAGE, type GpuChunks } from "../../src/instanced/pages.js";
import { GPU_TIMEOUT, render, renderer } from "../gpu.js";
import { must } from "../must.js";

// The app's side, as a test: a GPU pass that writes records and their count, and the instance function.

const CAPACITY = 1024;
const records = t3.instancedArray(CAPACITY * 4 * 2, d.vec4u);
const counts = t3.instancedArray(4, d.u32);
const first = t3.uniform(0, d.u32);
const count = t3.uniform(0, d.u32);
const counter = t3.uniform(0, d.u32);

/** Record k: a spot on a grid ahead of a camera at the origin looking down -z, and its hash. */
const emit = t3
  .toTSL(() => {
    "use gpu";
    const i = t3.instanceIndex.$;
    if (i >= count.$) return;
    const k = first.$ + i;
    const position = d.vec3f(d.f32(k % 8) * 3 - 10.5, 0, -(5 + d.f32(std.intdiv(k, 8)) * 2));
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

/** Records `from` to `from + n` as the CPU sees them: what `emit` and `place` make of them. */
function cpuChunk(from: number, n: number) {
  const matrices: number[] = [];
  const colors: number[] = [];
  const keeps: number[] = [];
  for (let k = from; k < from + n; k++) {
    const hash = Math.imul(k + 1, 2654435761) >>> 0;
    const s = 1 + (hash % 4) * 0.25;
    matrices.push(...new Matrix4().makeScale(s, s, s).setPosition((k % 8) * 3 - 10.5, 0, -(5 + Math.floor(k / 8) * 2)).elements);
    colors.push((hash % 3) * 0.5, 1, 0.5);
    keeps.push((hash % 1024) / 1024);
  }
  return { matrices, colors, keeps };
}

/** Write records `from` to `from + n` and their count into counter `index`, on the GPU. */
function produce(from: number, n: number, index: number): void {
  first.node.value = from;
  count.node.value = n;
  counter.node.value = index;
  void renderer.compute(emit);
}

/** Every record's origin lies in this box. */
const everywhere = new Box3(new Vector3(-11, 0, -600), new Vector3(11, 0, -4));
const box = () => new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
const read = (attribute: Parameters<typeof renderer.getArrayBufferAsync>[0]) => renderer.getArrayBufferAsync(attribute);

function crowd(gpuChunks?: Partial<GpuChunks>): InstancedLod {
  const options = gpuChunks && { gpuChunks: { instance: place, records: records.node.value, counts: counts.node.value, capacity: CAPACITY, scales: [1, 1.75], ...gpuChunks } as const };
  const lod = new InstancedLod([{ object: box() }, { object: box() }], options);
  lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 6][i] ?? level.maxPixels));
  return lod;
}

/** Per draw (each level's, then the contacts'), what `camera`'s slots hold: each instance's place, scale, colour and fade. */
async function drawn(lod: InstancedLod, camera: Camera): Promise<string[][]> {
  const levels = lod.children.filter((child) => child instanceof Instances);
  const contacts = lod.children.find((child) => child instanceof ContactMesh);
  const draws = levels.map((mesh, i) => ({ mesh, offset: i * ARGS_BYTES }));
  if (contacts) draws.push({ mesh: must(levels[0]), offset: contacts.selection.contactOffset });
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

const camera = new PerspectiveCamera(60, 1, 0.1, 1e4);
/** Sees every record from above. */
const above = new PerspectiveCamera(60, 1, 1, 1e4);
above.position.set(0, 800, -260);
above.lookAt(0, 0, -260);
above.updateMatrixWorld();

/** Render `lod` from `view` twice, so that it selects and takes in its chunks. */
async function frames(lod: InstancedLod, view = camera): Promise<void> {
  const scene = new Scene().add(lod);
  for (let i = 0; i < 2; i++) await render(scene, view);
}

afterEach(() => vi.restoreAllMocks());

describe("GPU chunks", { timeout: GPU_TIMEOUT }, () => {
  it("draw, thin, select and ring the same instances as the same records given from the CPU", async () => {
    const cpu = crowd();
    const gpu = crowd({});
    for (const lod of [cpu, gpu]) {
      lod.range = { camera, radius: 160, ramp: 120 };
      lod.contact = { radius: 1, strength: 1, distance: 30 };
    }
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
      await frames(cpu);
      await frames(gpu);
      const expected = await drawn(cpu, camera);
      // Both levels, thinned, and contacts near the camera.
      expect(expected.map((slots) => slots.length > 0)).toEqual([true, true, true]);
      expect(expected[0]?.length).toBeLessThan(1000);
      expect(await drawn(gpu, camera)).toEqual(expected);
      expect(await gpu.drained(renderer)).toBe(true);
    } finally {
      cpu.dispose();
      gpu.dispose();
    }
  });

  it("clamp a chunk the pool lacks pages for, then give it the rest once removed chunks return theirs", async () => {
    const lod = crowd({ pages: 4 });
    /** The instances drawn, each once, a fade's two levels included. */
    const total = async () => new Set((await drawn(lod, above)).flat().map((slot) => slot.split(" ")[0])).size;
    produce(0, 600, 0);
    produce(CAPACITY, 300, 1);
    const a = lod.addGpuChunk({ box: everywhere, first: 0, counter: 0 });
    try {
      await frames(lod, above);
      // 3 pages for the first, the last one for the second, a frame later.
      const b = lod.addGpuChunk({ box: everywhere, first: CAPACITY, counter: 1 });
      await frames(lod, above);
      expect(await total()).toBe(600 + PAGE);
      expect(await lod.drained(renderer)).toBe(false);
      // Asking takes in the removal, as the next draw would.
      lod.removeGpuChunk(a);
      expect(await lod.drained(renderer)).toBe(true);
      await frames(lod, above);
      expect(await total()).toBe(300);
      // Every page is back: a chunk needing all of them gets them, in the slot just freed.
      lod.removeGpuChunk(b);
      produce(CAPACITY, 4 * PAGE, 2);
      lod.addGpuChunk({ box: everywhere, first: CAPACITY, counter: 2 });
      await frames(lod, above);
      expect(await total()).toBe(4 * PAGE);
      expect(await lod.drained(renderer)).toBe(true);
    } finally {
      lod.dispose();
    }
  });

  it("read nothing back while chunks come and go and views move", async () => {
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
      // Only asking whether it drained reads back.
      expect(await lod.drained(renderer)).toBe(true);
      expect(readback).toHaveBeenCalled();
    } finally {
      camera.position.set(0, 0, 0);
      camera.updateMatrixWorld();
      lod.dispose();
    }
  });
});

/// <reference types="@webgpu/types" />
import { Matrix4, Sphere, Vector3, WebGPURenderer, type Renderer } from "three/webgpu";
import { expect, it, vi } from "vitest";
import { ARGS_BYTES } from "../../src/instanced/args.js";
import { Selection } from "../../src/instanced/select.js";
import { GPU_TIMEOUT, renderer } from "../gpu.js";

const levels = [{ maxPixels: Infinity }, { maxPixels: 10 }];

function selection(count: number, indexed: boolean, start: number, sphere = new Sphere(new Vector3(), 1)): Selection {
  const matrices = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) new Matrix4().makeTranslation(i + 1, 0, 0).toArray(matrices, i * 16);
  const selection = new Selection(
    matrices,
    sphere,
    [true, true],
    [
      { level: 0, count: 6, start: 0, indexed },
      { level: 1, count: 9, start, indexed },
    ],
    [0, 1],
  );
  selection.aim(new Vector3(), 1, true, false, 1, levels);
  return selection;
}

const read = (selection: Selection, gpu: Renderer = renderer) => gpu.getArrayBufferAsync(selection.args, null, selection.argsOffset, 2 * ARGS_BYTES);
const words = (buffer: ArrayBuffer) => Array.from(new Uint32Array(buffer));

it("shares native shader modules across crowd capacities, spheres and slot offsets", { timeout: GPU_TIMEOUT }, async () => {
  const a = selection(2, true, 6, new Sphere(new Vector3(1, 2, 3), 1.25));
  const b = selection(17, true, 6, new Sphere(new Vector3(-4, 5, -6), 3.5));
  const shader = vi.spyOn(GPUDevice.prototype, "createShaderModule");
  try {
    renderer.compute(a.take(renderer));
    expect(words(await read(a))).toEqual([6, 0, 0, 0, 0, 9, 2, 6, 0, 2]);
    const compiled = shader.mock.calls.length;
    expect(compiled).toBe(2);
    renderer.compute(b.take(renderer));
    expect(words(await read(b))).toEqual([6, 0, 0, 0, 0, 9, 17, 6, 0, 17]);
    // Three caches native pipelines by ComputeNode.id, but shares identical WGSL modules.
    expect(shader).toHaveBeenCalledTimes(compiled);
    expect(new Float32Array(await renderer.getArrayBufferAsync(b.slots.matrices))[17 * 16 + 12]).toBeGreaterThan(0);
  } finally {
    shader.mockRestore();
    a.dispose();
    b.dispose();
  }
});

it("installs lazy draws without replacing storage buffers already bound by render and shadow shaders", { timeout: GPU_TIMEOUT }, async () => {
  const draw = { level: 0, count: 6, start: 0, indexed: true };
  const a = new Selection(new Float32Array(new Matrix4().makeTranslation(3, 0, 0).elements), new Sphere(new Vector3(), 1), [true, true], [draw], [0, 0]);
  a.useColors(new Float32Array([0.25, 0.5, 0.75, 1]));
  const matrices = a.slots.matrices,
    colors = a.slots.colors,
    fades = a.slots.fades;
  try {
    a.aim(new Vector3(), 1, true, false, 1, levels);
    const kernels = a.take(renderer);
    renderer.compute(kernels);
    expect(words(await renderer.getArrayBufferAsync(a.args, null, a.argsOffset, ARGS_BYTES))).toEqual([6, 1, 0, 0, 0]);
    a.append([{ ...draw, level: 1, count: 9 }]);
    a.route([0, 1]);
    expect(a.slots.matrices).toBe(matrices);
    expect(a.slots.colors).toBe(colors);
    expect(a.slots.fades).toBe(fades);
    const installed = a.take(renderer);
    expect(installed).toBe(kernels);
    renderer.compute(installed);
    expect(words(await read(a))).toEqual([6, 0, 0, 0, 0, 9, 1, 0, 0, 1]);
    expect(new Float32Array(await renderer.getArrayBufferAsync(matrices))[16 + 12]).toBe(3);
    if (!colors) throw new Error("missing colors");
    expect(Array.from(new Float32Array(await renderer.getArrayBufferAsync(colors)).slice(4, 8))).toEqual([0.25, 0.5, 0.75, 1]);
  } finally {
    a.dispose();
  }
});

it("draws pending levels through a solid finer fallback and fades ready coarse levels against that fallback", { timeout: GPU_TIMEOUT }, async () => {
  const a = new Selection(
    new Float32Array(new Matrix4().elements),
    new Sphere(new Vector3(), 1),
    [true, false, true],
    [
      { level: 0, count: 6, start: 0, indexed: true },
      { level: 2, count: 9, start: 0, indexed: true },
    ],
    [0, 0, 2],
  );
  const thresholds = [{ maxPixels: Infinity }, { maxPixels: 100 }, { maxPixels: 10 }];
  try {
    // Height 95 lies in the unavailable level's fade: fallback must draw exactly once, solid.
    a.aim(new Vector3(0, 0, 2), 95, false, true, null, thresholds);
    renderer.compute(a.take(renderer));
    expect(words(await read(a))).toEqual([6, 1, 0, 0, 0, 9, 0, 0, 0, 1]);
    expect(new Float32Array(await renderer.getArrayBufferAsync(a.slots.fades))[0]).toBe(0);
    // Height 9.5 fades a ready coarse card against level 0, skipping pending level 1.
    a.aim(new Vector3(0, 0, 2), 9.5, false, true, null, thresholds);
    renderer.compute(a.take(renderer));
    expect(words(await read(a))).toEqual([6, 1, 0, 0, 0, 9, 1, 0, 0, 1]);
    const fades = new Float32Array(await renderer.getArrayBufferAsync(a.slots.fades));
    expect(fades[0]).toBeCloseTo(-0.5);
    expect(fades[1]).toBeCloseTo(0.5);
  } finally {
    a.dispose();
  }
});

it("initializes appended and reused GPU slices without overwriting live draws or local firstInstance", { timeout: GPU_TIMEOUT }, async () => {
  const a = selection(3, true, 6);
  let b: Selection | undefined;
  let replacement: Selection | undefined;
  try {
    renderer.compute(a.take(renderer));
    expect(words(await read(a))).toEqual([6, 0, 0, 0, 0, 9, 3, 6, 0, 3]);
    b = selection(2, false, 12);
    expect(b.args).toBe(a.args);
    renderer.compute(b.take(renderer));
    expect(words(await read(b))).toEqual([6, 0, 0, 0, 0, 9, 2, 12, 2, 0]);
    expect(words(await read(a))).toEqual([6, 0, 0, 0, 0, 9, 3, 6, 0, 3]);

    // The copy is submitted before disposal. Reuse can happen while its readback
    // is pending; queue order must preserve both the old draw and the new one.
    const pending = read(a);
    a.dispose();
    replacement = selection(4, false, 21);
    expect(replacement.args).toBe(b.args);
    expect(replacement.argsOffset).toBe(a.argsOffset);
    renderer.compute(replacement.take(renderer));
    expect(words(await pending)).toEqual([6, 0, 0, 0, 0, 9, 3, 6, 0, 3]);
    expect(words(await read(replacement))).toEqual([6, 0, 0, 0, 0, 9, 4, 21, 4, 0]);
    expect(words(await read(b))).toEqual([6, 0, 0, 0, 0, 9, 2, 12, 2, 0]);
  } finally {
    a.dispose();
    b?.dispose();
    replacement?.dispose();
  }
});

it("initializes each renderer and keeps a lagging renderer's matrices and late colors current", { timeout: GPU_TIMEOUT }, async () => {
  const other = new WebGPURenderer({ antialias: false });
  const a = selection(3, true, 6);
  try {
    await other.init();
    renderer.compute(a.take(renderer));
    other.compute(a.take(other));
    expect(words(await read(a, other))).toEqual([6, 0, 0, 0, 0, 9, 3, 6, 0, 3]);

    a.matrices.array[12] = 10;
    a.matrices.addUpdateRange(0, 16);
    a.matrices.needsUpdate = true;
    a.changed();
    renderer.compute(a.take(renderer));
    a.matrices.array[28] = 20;
    a.matrices.addUpdateRange(16, 16);
    a.matrices.needsUpdate = true;
    a.changed();
    a.useColors(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]));
    other.compute(a.take(other));
    const matrices = new Float32Array(await other.getArrayBufferAsync(a.slots.matrices));
    expect([3, 4, 5].map((i) => matrices[i * 16 + 12]).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([3, 10, 20]);
    const colors = a.slots.colors;
    if (!colors) throw new Error("missing output colors");
    const rgb = new Float32Array(await other.getArrayBufferAsync(colors));
    expect([3, 4, 5].map((i) => Array.from(rgb.slice(i * 4, i * 4 + 3)).join()).sort()).toEqual(["0,0,1", "0,1,0", "1,0,0"]);
    renderer.compute(a.take(renderer));
    expect(words(await read(a))).toEqual([6, 0, 0, 0, 0, 9, 3, 6, 0, 3]);
  } finally {
    a.dispose();
    other.dispose();
  }
});

it("hands over an arriving fade neighbour without a jump at either end of the height fade", { timeout: GPU_TIMEOUT }, async () => {
  const draw = { level: 0, count: 6, start: 0, indexed: true };
  const a = new Selection(new Float32Array(new Matrix4().elements), new Sphere(new Vector3(), 1), [true, true, true], [draw, { ...draw, level: 2 }], [0, 0, 2]);
  const thresholds = [{ maxPixels: Infinity }, { maxPixels: 100 }, { maxPixels: 10 }];
  try {
    a.aim(new Vector3(0, 0, 2), 9.5, false, true, null, thresholds);
    const kernels = a.take(renderer);
    renderer.compute(kernels);
    a.append([{ ...draw, level: 1 }]);
    a.route([0, 1, 2], true);
    for (const [progress, expected] of [
      [0, [-0.5, null, 0.5]],
      [1 / 6, [-0.75, null, 0.75]],
      [0.5, [-0.5, 0.5, null]],
      [5 / 6, [null, -0.75, 0.75]],
      [1, [null, -0.5, 0.5]],
    ] satisfies Array<[number, Array<number | null>]>) {
      a.progress.value = progress;
      a.changed();
      expect(a.take(renderer)).toBe(kernels);
      renderer.compute(kernels);
      const counts = new Uint32Array(await renderer.getArrayBufferAsync(a.args, null, a.argsOffset, 3 * ARGS_BYTES));
      const fades = new Float32Array(await renderer.getArrayBufferAsync(a.slots.fades));
      for (const [level, word] of [
        [0, 1],
        [1, 11],
        [2, 6],
      ]) {
        if (level === undefined || word === undefined) throw new Error("Missing draw index");
        const expectedFade = expected[level];
        expect(counts[word]).toBe(expectedFade === null ? 0 : 1);
        if (expectedFade !== null && expectedFade !== undefined) expect(fades[level]).toBeCloseTo(expectedFade);
      }
    }
  } finally {
    a.dispose();
  }
});

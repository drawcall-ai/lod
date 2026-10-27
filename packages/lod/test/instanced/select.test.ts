import { Matrix4, Sphere, Vector3, WebGPURenderer, type Renderer } from "three/webgpu";
import { expect, it } from "vitest";
import { ARGS_BYTES, Selection } from "../../src/instanced/select.js";
import { GPU_TIMEOUT, renderer } from "../gpu.js";

const levels = [{ maxPixels: Infinity }, { maxPixels: 10 }];

function selection(count: number, indexed: boolean, start: number): Selection {
  const matrices = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) new Matrix4().makeTranslation(i + 1, 0, 0).toArray(matrices, i * 16);
  const selection = new Selection(
    matrices,
    new Sphere(new Vector3(), 1),
    [true, true],
    [
      { level: 0, count: 6, start: 0, indexed },
      { level: 1, count: 9, start, indexed },
    ],
  );
  selection.aim(new Vector3(), 1, true, false, 1, levels);
  return selection;
}

const read = (selection: Selection, gpu: Renderer = renderer) => gpu.getArrayBufferAsync(selection.args, null, selection.argsOffset, 2 * ARGS_BYTES);
const words = (buffer: ArrayBuffer) => Array.from(new Uint32Array(buffer));

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

it("reuses only a supplied stable selection proof and invalidates it for instance edits", () => {
  const a = selection(1, true, 0);
  const stable = {};
  try {
    a.aim(new Vector3(), 1, true, false, 1, levels, stable);
    expect(a.take(renderer)).toHaveLength(2);
    a.aim(new Vector3(1, 0, 0), 2, true, false, 1, levels, stable);
    expect(a.take(renderer)).toHaveLength(0);
    a.changed();
    a.aim(new Vector3(2, 0, 0), 3, true, false, 1, levels, stable);
    expect(a.take(renderer)).toHaveLength(2);
    a.aim(new Vector3(3, 0, 0), 4, true, false, 1, levels);
    expect(a.take(renderer)).toHaveLength(2);
  } finally {
    a.dispose();
  }
});

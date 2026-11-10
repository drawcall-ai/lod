import { StorageBufferAttribute } from "three/webgpu";
import { Fn, instanceIndex, int, storage, uint, vec4 } from "three/tsl";
import { describe, expect, it } from "vitest";
import { FADE, drawLevels, drawnLevel, levelsToDraw, levelsToDrawNode } from "../../src/levels/draw.js";
import { GPU_TIMEOUT, renderer } from "../renderer.js";

/** A ladder of levels: each one's maxPixels and the bits of those that draw nothing. */
interface Ladder {
  maxPixels: number[];
  empty: number;
}

/** The source, two levels used up to 400 and 100 px, and an empty one under 10 px. */
const four: Ladder = { maxPixels: [Infinity, 400, 100, 10], empty: 0b1000 };
/** Six levels, the third and the last empty: maxPixels in both of the GPU's vec4s. */
const six: Ladder = { maxPixels: [Infinity, 800, 400, 100, 30, 10], empty: 0b100100 };

const encode = ({ maxPixels, empty }: Ladder, forced = -1, fades = 1) =>
  drawLevels(
    maxPixels.map((value) => ({ maxPixels: value })),
    empty,
    forced < 0 ? null : forced,
    fades === 1,
  );
const ALL = 0b1111;
const draw = (height: number, loaded = ALL, before = loaded, progress = 1, levels = encode(four)) => levelsToDraw(height, levels, loaded, before, progress);

describe("levelsToDraw", () => {
  it("draws the last level a height fits, and inside the top FADE of its range its finer neighbour with the opposite fade", () => {
    expect(draw(1000)).toEqual({ level: 0, finer: 0, fade: 0 });
    expect(draw(250)).toEqual({ level: 1, finer: 1, fade: 0 });
    const fading = draw(400 * (1 - FADE / 2));
    expect(fading).toMatchObject({ level: 1, finer: 0 });
    expect(fading.fade).toBeCloseTo(0.5, 6);
    expect(draw(400 * (1 - FADE / 2), ALL, ALL, 1, encode(four, -1, 0))).toEqual({ level: 1, finer: 1, fade: 0 });
    expect(draw(400 * (1 - FADE / 2), ALL, ALL, 1, encode(four, 2))).toEqual({ level: 2, finer: 2, fade: 0 });
  });

  it("draws nothing until the coarsest level that draws something has loaded, whatever finer ones have", () => {
    expect(draw(1000, 0b0011)).toEqual({ level: -1, finer: -1, fade: 0 });
    expect(draw(400 * (1 - FADE / 2), 0b0010)).toEqual({ level: -1, finer: -1, fade: 0 });
    // The empty level 3 is loaded but draws nothing: it is not the coarsest that draws something.
    expect(draw(5, 0b1001)).toEqual({ level: -1, finer: -1, fade: 0 });
    expect(draw(1000, 0b0100)).toEqual({ level: 2, finer: 2, fade: 0 });
  });

  it("stands the nearest loaded coarser level that draws something in for a missing one, never a finer one", () => {
    expect(draw(1000, 0b0110)).toEqual({ level: 1, finer: 1, fade: 0 });
    expect(draw(250, 0b0101)).toEqual({ level: 2, finer: 2, fade: 0 });
    // A finer neighbour that has not loaded leaves no fade.
    expect(draw(400 * (1 - FADE / 2), 0b0110)).toEqual({ level: 1, finer: 1, fade: 0 });
  });

  it("passes an arrival from the old levels to the new in three steps with two draws, and draws one where nothing drew at once", () => {
    // Level 0 arrives over level 1 drawing in its place.
    expect(draw(1000, ALL, 0b1110, 0.1)).toEqual({ level: 1, finer: 1, fade: 0 });
    const half = draw(1000, ALL, 0b1110, 0.5);
    expect(half).toMatchObject({ level: 0, finer: 1 });
    expect(half.fade).toBeCloseTo(0.5, 6);
    expect(draw(1000, ALL, 0b1110, 0.9)).toEqual({ level: 0, finer: 0, fade: 0 });
    expect(draw(1000, 0b0101, 0b0001, 0.1)).toEqual({ level: 0, finer: 0, fade: 0 });
  });
});

it("names the level that draws most of the pixels: the finer one once its fade exceeds one half", () => {
  expect(drawnLevel({ level: 1, finer: 0, fade: 0.25 })).toBe(1);
  expect(drawnLevel({ level: 1, finer: 0, fade: 0.5 })).toBe(1);
  expect(drawnLevel({ level: 1, finer: 0, fade: 0.75 })).toBe(0);
  expect(drawnLevel({ level: -1, finer: -1, fade: 0 })).toBeNull();
});

/**
 * Inputs spread over every rule: heights around each threshold and fade (off the knife edges, where f32 rounds
 * differently), loaded sets, arrivals and settings.
 */
function cases(heights: number[], sets: number[]) {
  const progresses = [1, 0, 0.2, 0.5, 0.8];
  const all: { height: number; loaded: number; before: number; progress: number; forced: number; fades: number }[] = [];
  for (const height of heights)
    for (const loaded of sets)
      for (const before of sets)
        for (const progress of progresses)
          for (const [forced, fades] of [
            [-1, 1],
            [-1, 0],
            [1, 0],
          ] as const)
            all.push({ height, loaded, before, progress, forced, fades });
  return all;
}

/** levelsToDraw over `inputs` of `ladder` on the GPU, against the same on the CPU. */
async function compare(ladder: Ladder, inputs: ReturnType<typeof cases>): Promise<void> {
  const n = inputs.length;
  const floats = (values: number[]) => storage(new StorageBufferAttribute(new Float32Array(values), 1), "float", n).toReadOnly();
  const uints = (values: number[]) => storage(new StorageBufferAttribute(new Uint32Array(values), 1), "uint", n).toReadOnly();
  const ints = (values: number[]) => storage(new StorageBufferAttribute(new Int32Array(values), 1), "int", n).toReadOnly();
  const height = floats(inputs.map((c) => c.height));
  const loaded = uints(inputs.map((c) => c.loaded));
  const before = uints(inputs.map((c) => c.before));
  const progress = floats(inputs.map((c) => c.progress));
  const forced = ints(inputs.map((c) => c.forced));
  const fades = uints(inputs.map((c) => c.fades));
  const result = new StorageBufferAttribute(new Float32Array(n * 4), 4);
  const out = storage(result, "vec4", n);
  const [m0 = 0, m1 = 0, m2 = 0, m3 = 0, m4 = 0, m5 = 0, m6 = 0, m7 = 0] = encode(ladder).maxPixels;
  const shader = Fn(() => {
    const i = instanceIndex;
    const drawn = levelsToDrawNode({
      height: height.element(i),
      count: int(ladder.maxPixels.length),
      low: vec4(m0, m1, m2, m3),
      high: vec4(m4, m5, m6, m7),
      empty: uint(ladder.empty),
      coarsest: int(encode(ladder).coarsest),
      forced: forced.element(i),
      fades: fades.element(i),
      loaded: loaded.element(i),
      before: before.element(i),
      progress: progress.element(i),
    });
    out.element(i).assign(vec4(drawn, 0));
  })().compute(n);
  await renderer.computeAsync(shader);
  const gpu = new Float32Array(await renderer.getArrayBufferAsync(result));
  inputs.forEach((c, i) => {
    const cpu = draw(c.height, c.loaded, c.before, c.progress, encode(ladder, c.forced, c.fades));
    const where = JSON.stringify(c);
    expect([gpu[i * 4], gpu[i * 4 + 1]], where).toEqual([cpu.level, cpu.finer]);
    expect(gpu[i * 4 + 2], where).toBeCloseTo(cpu.fade, 5);
  });
}

it("computes the same on the GPU as on the CPU, with levels in both of the GPU's vec4s", { timeout: GPU_TIMEOUT }, async () => {
  await compare(
    four,
    cases([2000, 401, 399, 380, 361, 350, 101, 99, 95, 91, 50, 11, 9.5, 8, 1], [ALL, 0b0001, 0b0010, 0b0100, 0b0101, 0b0110, 0b1001, 0b1110, 0]),
  );
  await compare(
    six,
    cases([2000, 790, 750, 401, 380, 101, 95, 50, 29, 28, 9.5, 1], [0b111111, 0b010000, 0b010011, 0b011010, 0b001011, 0b110101, 0b011111, 0b100000, 0]),
  );
});

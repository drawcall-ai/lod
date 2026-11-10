import { expect, it } from "vitest";
import { FADE, drawLevels, levelsToDraw } from "../../src/levels/draw.js";
import { LevelHeights, drawnBits, levelsToLoad } from "../../src/levels/load.js";

/** The source, two levels used up to 400 and 100 px, and an empty one under 10 px. */
const levels = (forced: number | null = null, fades = true) =>
  drawLevels(
    [Infinity, 400, 100, 10].map((maxPixels) => ({ maxPixels })),
    0b1000,
    forced,
    fades,
  );
const heights = (forced: number | null = null, fades = true) => new LevelHeights(levels(forced, fades));
const at = (height: number) => [height, height] as const;

it("wants each height's level, inside its fade its finer neighbour, and with any that draws the coarsest that draws", () => {
  expect(levelsToLoad([at(1000)], heights())).toBe(0b0101);
  expect(levelsToLoad([at(250)], heights())).toBe(0b0110);
  expect(levelsToLoad([at(50)], heights())).toBe(0b0100);
  expect(levelsToLoad([at(400 * (1 - FADE / 2))], heights())).toBe(0b0111);
  expect(levelsToLoad([at(400 * (1 - FADE / 2))], heights(null, false))).toBe(0b0110);
  // Where only the empty level draws, nothing draws: the coarsest is not wanted for it.
  expect(levelsToLoad([at(5)], heights())).toBe(0b1000);
  expect(levelsToLoad([at(5), at(50)], heights())).toBe(0b1100);
  expect(levelsToLoad([], heights())).toBe(0);
});

it("wants every level a range of heights draws, and only the forced level with one", () => {
  expect(levelsToLoad([[5, 1000]], heights())).toBe(0b1111);
  expect(levelsToLoad([at(1000), at(50)], heights())).toBe(0b0101);
  expect(levelsToLoad([at(1000)], heights(1))).toBe(0b0110);
});

it("draws at every height what levelsToDraw draws, around every maxPixels and fade start and between them, loaded or not", () => {
  const float = new Float32Array(1);
  const bits = new Uint32Array(float.buffer);
  /** The f32s `steps` steps either side of `value`. */
  const around = (value: number, steps: number) =>
    Array.from({ length: 2 * steps + 1 }, (_, i) => {
      float[0] = value;
      bits[0] = (bits[0] ?? 0) + i - steps;
      return float[0] ?? 0;
    });
  const thresholds = [Infinity, 517.3, 211.9, 47.03, 12.5, 3.3];
  const all = (1 << thresholds.length) - 1;
  for (const [forced, fades] of [
    [null, true],
    [null, false],
    [2, true],
  ] as const) {
    // Level 4 draws nothing.
    const encoded = drawLevels(
      thresholds.map((maxPixels) => ({ maxPixels })),
      0b10000,
      forced,
      fades,
    );
    const edges = thresholds.slice(1).flatMap((maxPixels) => [maxPixels, Math.fround(maxPixels) * (1 - FADE)]);
    const asked = [0, 1e-3, 1e6, 3e38, ...edges.flatMap((edge) => around(edge, 6))];
    for (let i = 0; i < 300; i++) asked.push(((i * 7919) % 600) * 1.0137 + i / 997);
    for (const loaded of [all, 0b101011, 0b011000, 0b000001]) {
      const table = new LevelHeights(encoded, loaded);
      for (const height of asked) {
        const drawn = drawnBits(levelsToDraw(height, encoded, loaded, loaded, 1));
        expect(table.drawnIn(height, height), `${height} (forced ${forced}, fades ${fades}, loaded ${loaded})`).toBe(drawn);
      }
      // A range draws what its heights draw.
      expect(table.drawnIn(0, 3e38)).toBe(asked.reduce((union, height) => union | table.drawnIn(height, height), 0));
    }
  }
});

it("draws only what the levels before or after draw while an arrival is under way", () => {
  const encoded = drawLevels(
    [Infinity, 400, 100, 10].map((maxPixels) => ({ maxPixels })),
    0,
    null,
    true,
  );
  const before = 0b1100;
  const loaded = 0b1110;
  const now = new LevelHeights(encoded, loaded);
  const then = new LevelHeights(encoded, before);
  for (let height = 0.5; height < 600; height *= 1.03)
    for (const progress of [0, 0.1, 1 / 3, 0.5, 2 / 3, 0.9]) {
      const drawn = drawnBits(levelsToDraw(height, encoded, loaded, before, progress));
      expect(drawn & ~(now.drawnIn(height, height) | then.drawnIn(height, height)), `${height} at ${progress}`).toBe(0);
    }
});

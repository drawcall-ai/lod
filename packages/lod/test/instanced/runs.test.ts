import { expect, it } from "vitest";
import { Runs } from "../../src/instanced/runs.js";

it("takes first-fit runs, merges what is given back and grows or shrinks only past taken runs", () => {
  const runs = new Runs(8);
  expect([runs.take(3), runs.take(2), runs.take(3)]).toEqual([0, 3, 5]);
  expect(runs.take(1)).toBe(null);
  runs.give(0, 3);
  // Too long for the hole at the front.
  expect(runs.take(4)).toBe(null);
  runs.give(3, 2);
  expect(runs.end).toBe(8);
  expect(runs.take(4)).toBe(0);
  runs.give(5, 3);
  expect(runs.end).toBe(4);
  expect(() => runs.resize(2)).toThrow(/cuts a taken run/);
  runs.resize(4);
  expect(runs.take(1)).toBe(null);
  runs.resize(16);
  expect(runs.take(12)).toBe(4);
  expect(runs.end).toBe(16);
});

import { describe, expect, it } from "vitest";
import { Matrix4, Sphere, Vector3 } from "three/webgpu";
import { Blocks, type BlockView } from "../../src/instanced/blocks.js";

const levels = [Infinity, 40, 10].map((maxPixels) => ({ maxPixels }));
const identity = new Matrix4();
function setup(count: number) {
  const matrices = new Float32Array(count * 16);
  const spheres = new Float32Array(count * 4);
  const source = new Sphere(new Vector3(), 1);
  const blocks = new Blocks(matrices, spheres, source, new Sphere(), 0, source);
  const reaches = levels.map(() => new Sphere());
  const view: BlockView = { eye: new Vector3(), scale: 100, ortho: false, fades: true, forced: null };
  const set = (index: number, matrix: Matrix4) => matrix.toArray(matrices, index * 16);
  const refit = (start = 0, end = count) => {
    blocks.measure(start, end);
    blocks.refit();
  };
  const select = () => blocks.select(levels, view, reaches, true, identity);
  return { blocks, reaches, view, set, refit, select };
}

describe("instance blocks", () => {
  it("reuses a solid multi-level selection and invalidates changed instances", () => {
    const s = setup(128);
    for (let i = 0; i < 128; i++) s.set(i, new Matrix4().makeTranslation(0, 0, i < 64 ? -2 : -100));
    s.refit();
    const first = s.select();
    expect(first).toBeDefined();
    expect(s.reaches.map((sphere) => !sphere.isEmpty())).toEqual([true, false, true]);
    s.view.eye.x = 0.01;
    expect(s.select()).toBe(first);
    s.set(5, new Matrix4().makeTranslation(0, 0, -100));
    s.refit(5, 6);
    expect(s.select()).not.toBe(first);
    s.view.scale = 1;
    const coarse = s.select();
    expect(coarse).not.toBe(first);
    s.view.scale = 100;
    expect(s.select()).not.toBe(coarse);
  });

  it("keeps both fade neighbours and avoids proofs near float32 switch boundaries", () => {
    const s = setup(1);
    for (const height of [36, 36 + 1e-7, 38, 40 - 1e-7, 40, 40 + 1e-7]) {
      s.set(0, new Matrix4().makeTranslation(0, 0, -200 / height));
      s.refit();
      expect(s.select()).toBeUndefined();
      expect(s.reaches[0]?.isEmpty()).toBe(false);
      expect(s.reaches[1]?.isEmpty()).toBe(false);
    }
  });

  it.each([10, Infinity])("keeps the source for float32 overflow even when the coarse threshold is %s", (threshold) => {
    const s = setup(1);
    const ladder = levels.map((level, i) => ({ ...level, maxPixels: i === 0 ? Infinity : threshold }));
    s.set(0, new Matrix4().makeScale(1e20, 1e20, 1e20).setPosition(0, 0, -1e22));
    s.refit();
    expect(s.blocks.select(ladder, s.view, s.reaches, true, identity)).toBeUndefined();
    expect(s.reaches.every((sphere) => !sphere.isEmpty())).toBe(true);
    expect(s.reaches[0]?.center.z).toBeLessThan(-1e21);
  });
});

it("demands detail 20% before its fade without changing the solid draw token", () => {
  const s = setup(1);
  s.set(0, new Matrix4().makeTranslation(0, 0, -200 / 30));
  s.refit();
  const selected = s.select();
  expect(s.reaches.map((bound) => !bound.isEmpty())).toEqual([false, true, false]);
  const demand = levels.map(() => new Sphere());
  s.blocks.demand(levels, s.view, demand, identity);
  expect(demand.map((bound) => !bound.isEmpty())).toEqual([true, true, false]);
  expect(s.select()).toBe(selected);
  s.set(0, new Matrix4().makeTranslation(0, 0, -200 / 28));
  s.refit();
  s.blocks.demand(levels, s.view, demand, identity);
  expect(demand[0]?.isEmpty()).toBe(true);
});

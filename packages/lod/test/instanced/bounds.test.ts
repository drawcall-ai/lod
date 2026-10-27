import { describe, expect, it } from "vitest";
import { Matrix4, Object3D, Sphere, Vector3 } from "three/webgpu";
import { Bounds, stretch, type BoundsView } from "../../src/instanced/bounds.js";
import type { LodLevel } from "../../src/levels.js";

const levels: LodLevel[] = [Infinity, 40, 10].map((maxPixels) => ({ object: new Object3D(), maxPixels }));
const identity = new Matrix4();
function setup(count: number, source = new Sphere(new Vector3(), 1), draws = 0) {
  const matrices = new Float32Array(count * 16);
  const spheres = new Float32Array(count * 4);
  const bounds = new Bounds(matrices, spheres, source, new Sphere(), draws);
  const reaches = levels.map(() => new Sphere());
  const view: BoundsView = { eye: new Vector3(), scale: 100, ortho: false, fades: true, forced: null };
  const set = (index: number, matrix: Matrix4) => matrix.toArray(matrices, index * 16);
  const refit = (start = 0, end = count) => {
    bounds.measure(start, end);
    bounds.refit();
  };
  const select = (measured = true, root = identity) => bounds.select(levels, view, reaches, measured, root);
  return { matrices, spheres, bounds, reaches, view, set, refit, select };
}

// Match the shader's float32 operations, independently of its conservative CPU bounds.
const f = Math.fround;
function gpuLevels(matrix: Matrix4, source: Sphere, view: BoundsView, ladder = levels): number[] {
  const e = matrix.elements;
  const dot = (a: number, b: number, c: number) => f(f(f(a * a) + f(b * b)) + f(c * c));
  const scale = f(Math.sqrt(Math.max(dot(e[0], e[1], e[2]), dot(e[4], e[5], e[6]), dot(e[8], e[9], e[10]))));
  const radius = f(f(source.radius) * scale);
  if (radius === 0) return [];
  const x = f(f(f(f(e[0] * f(source.center.x)) + f(e[4] * f(source.center.y))) + f(e[8] * f(source.center.z))) + e[12]);
  const y = f(f(f(f(e[1] * f(source.center.x)) + f(e[5] * f(source.center.y))) + f(e[9] * f(source.center.z))) + e[13]);
  const z = f(f(f(f(e[2] * f(source.center.x)) + f(e[6] * f(source.center.y))) + f(e[10] * f(source.center.z))) + e[14]);
  const size = f(f(radius * 2) * f(view.scale));
  const distance = f(Math.sqrt(dot(f(x - f(view.eye.x)), f(y - f(view.eye.y)), f(z - f(view.eye.z)))));
  const height = view.ortho ? size : f(size / Math.max(distance, f(1e-6)));
  let chosen = 0;
  for (let i = 1; i < ladder.length; i++) if (height <= f(Math.min(ladder[i]?.maxPixels ?? 0, 3.4e38))) chosen = i;
  chosen = view.forced ?? chosen;
  const result = [chosen];
  if (view.fades && chosen > 0 && height > f(f(Math.min(ladder[chosen]?.maxPixels ?? 0, 3.4e38)) * f(0.9))) result.push(chosen - 1);
  return result;
}

describe("cached instance bounds", () => {
  it.each([
    { count: 2, draws: 7, empty: false },
    { count: 2, draws: 8, empty: true },
    { count: 4096, draws: 8, empty: true },
    { count: 4097, draws: 8, empty: false },
  ])("tightens small multipart crowds: $count instances, $draws draws", ({ count, draws, empty }) => {
    const s = setup(count, new Sphere(new Vector3(), 1), draws);
    for (let i = 0; i < count; i++) s.set(i, new Matrix4().makeTranslation(i % 2 ? 100 : -100, 0, 0));
    s.refit();
    s.select();
    // The crowd surrounds the camera, but every instance is well inside the coarse
    // tier. A broad leaf cannot prove the expensive source level has no instances.
    expect(s.reaches[0]?.isEmpty()).toBe(empty);
    expect(s.reaches[2]?.isEmpty()).toBe(false);
  });

  it("keeps empty crowds empty even before learning the viewport", () => {
    const s = setup(0);
    s.refit();
    expect(s.select(false)).toBeUndefined();
    expect(s.reaches.every((sphere) => sphere.isEmpty())).toBe(true);
  });

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
    s.view.forced = 1;
    s.view.fades = false;
    expect(s.select()).toBeDefined();
    expect(s.reaches.map((sphere) => !sphere.isEmpty())).toEqual([false, true, false]);
  });

  it("does not reuse stale child proofs after a whole branch changed levels", () => {
    const s = setup(128);
    for (let i = 0; i < 128; i++) s.set(i, new Matrix4().makeTranslation(0, 0, i < 64 ? -2 : -100));
    s.refit();
    const first = s.select();
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

  it("bounds sheared geometry and wind even when the crowd root is also sheared", () => {
    const source = new Sphere(new Vector3(2, -1, 3), 2);
    const s = setup(1, source);
    const matrix = new Matrix4().set(1, 2, 0, 10, 0, 1, 1, -5, 0, 0, 0.5, -80, 0, 0, 0, 1);
    const root = new Matrix4().set(1, 1, 0, 0, 0, 1, 2, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    s.set(0, matrix);
    s.refit();
    s.bounds.pad(0.25);
    s.bounds.refit();
    s.view.forced = 0;
    s.view.fades = false;
    s.select(true, root);
    const sphere = s.reaches[0]?.clone().applyMatrix4(root);
    expect(sphere).toBeDefined();
    for (let i = 0; i < 1000; i++) {
      const direction = new Vector3(Math.sin(i), Math.cos(i * 0.73), Math.sin(i * 0.39)).normalize();
      const point = direction
        .multiplyScalar(source.radius * 1.25)
        .add(source.center)
        .applyMatrix4(matrix)
        .applyMatrix4(root);
      expect(sphere?.containsPoint(point)).toBe(true);
    }
    expect(stretch(matrix)).toBeGreaterThan(matrix.getMaxScaleOnAxis());
  });

  it("keeps every level for float32 overflow in length intermediates", () => {
    const s = setup(1);
    s.set(0, new Matrix4().makeScale(1e20, 1e20, 1e20).setPosition(0, 0, -1e22));
    s.refit();
    expect(s.select()).toBeUndefined();
    expect(s.reaches.every((sphere) => !sphere.isEmpty())).toBe(true);
    const matrix = new Matrix4().fromArray(s.matrices);
    expect(gpuLevels(matrix, new Sphere(new Vector3(), 1), s.view)).toEqual([0]);
    // The camera-centered tightening assumes a finite height/distance relation.
    expect(s.reaches[0]?.center.z).toBeLessThan(-1e21);
  });

  it("keeps the source for NaN GPU height even with infinite coarse thresholds", () => {
    const s = setup(1);
    const infinite = levels.map((level) => ({ ...level, maxPixels: Infinity }));
    s.set(0, new Matrix4().makeScale(1e20, 1e20, 1e20).setPosition(0, 0, -1e22));
    s.refit();
    const matrix = new Matrix4().fromArray(s.matrices);
    expect(gpuLevels(matrix, new Sphere(new Vector3(), 1), s.view, infinite)).toEqual([0]);
    expect(s.bounds.select(infinite, s.view, s.reaches, true, identity)).toBeUndefined();
    expect(s.reaches.every((sphere) => !sphere.isEmpty())).toBe(true);
    s.view.forced = 1;
    s.view.fades = false;
    s.bounds.select(infinite, s.view, s.reaches, true, identity);
    expect(s.reaches.map((sphere) => !sphere.isEmpty())).toEqual([false, true, false]);
  });

  it.each([0, 8])("never hides an emitted level across views and affine transforms with %i draws", (draws) => {
    const source = new Sphere(new Vector3(2, -1, 3), 1.7);
    const s = setup(257, source, draws);
    let seed = 17;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 257; i++) {
      const scale = i % 11 ? 0.1 + random() * 8 : 0;
      s.set(
        i,
        new Matrix4().set(
          scale,
          random() * scale,
          0,
          (random() - 0.5) * 500,
          0,
          scale * 2,
          0,
          (random() - 0.5) * 100,
          0,
          scale,
          scale,
          -random() * 1000,
          0,
          0,
          0,
          1,
        ),
      );
    }
    s.refit();
    const matrix = new Matrix4();
    for (let frame = 0; frame < 80; frame++) {
      // Exercise full, contiguous and scattered edits as well as moving views.
      // Refit once after all writes, as a caller editing a dynamic crowd would.
      if (frame % 4 === 0) {
        const start = frame === 0 ? 0 : (frame * 7) % 240;
        const end = frame === 0 ? 257 : start + 17;
        for (let i = start; i < end; i++) {
          matrix.fromArray(s.matrices, i * 16).setPosition((random() - 0.5) * 500, random() * 100, -random() * 1000);
          s.set(i, matrix);
        }
        s.bounds.measure(start, end);
        for (const i of [0, 64, 256]) {
          matrix.fromArray(s.matrices, i * 16).setPosition((random() - 0.5) * 500, random() * 100, -random() * 1000);
          s.set(i, matrix);
          s.bounds.measure(i, i + 1);
        }
        s.bounds.refit();
      }
      s.view.eye.set((random() - 0.5) * 600, random() * 200, (random() - 0.5) * 1000);
      s.view.scale = 1 + random() * 500;
      s.view.ortho = frame % 3 === 0;
      s.view.fades = !s.view.ortho;
      s.select();
      for (let i = 0; i < 257; i++) {
        matrix.fromArray(s.matrices, i * 16);
        for (const level of gpuLevels(matrix, source, s.view)) {
          const sphere = s.reaches[level];
          expect(sphere?.isEmpty()).toBe(false);
          const center = source.center.clone().applyMatrix4(matrix);
          expect((sphere?.center.distanceTo(center) ?? Infinity) + source.radius * stretch(matrix)).toBeLessThanOrEqual((sphere?.radius ?? 0) + 1e-3);
        }
      }
    }
  });
});

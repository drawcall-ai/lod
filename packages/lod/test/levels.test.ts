import { Box3, BoxGeometry, Mesh, MeshStandardMaterial, PerspectiveCamera, SphereGeometry } from "three/webgpu";
import { describe, expect, it } from "vitest";
import type { Impostor } from "../src/impostor/impostor.js";
import { ImpostorMesh } from "../src/impostor/mesh/index.js";
import { InstancedLod } from "../src/instanced/index.js";
import { Lod } from "../src/lod.js";
import { simplify } from "../src/simplify.js";
import { LazyLevel } from "../src/lazy.js";
import { fallbacks } from "../src/levels.js";
import { must } from "./must.js";

const box = () => new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial());
const sphere = () => new Mesh(new SphereGeometry(1, 64, 32), new MeshStandardMaterial());
const thresholds = (lod: { levels: ReadonlyArray<{ maxPixels: number }> }) => lod.levels.map((level) => level.maxPixels);

/** An impostor of a 2-unit box seen whole in frames of 4 texels: two texels span a pixel at 4 × r / (2 × 1.5) px. */
const impostor = (): Impostor => ({
  version: 3,
  layout: "full",
  frames: 4,
  size: 16,
  box: [-1, 0, -1, 1, 2, 1],
  halfSize: 1.5,
  maps: ["base", "normalDepth", "orm"],
  layers: [0, 1, 2].map(() => [16, 8, 4].map((size) => new Uint8Array(size * size * 4))),
});

describe("default maxPixels", () => {
  it("puts an impostor where two atlas texels span a pixel", () => {
    const [, level] = thresholds(new Lod([box(), new ImpostorMesh(impostor())]));
    expect(level).toBeCloseTo((4 * Math.sqrt(3)) / 3, 9);
  });

  it("puts a simplified level where its error reaches a pixel, and keeps it in a cloned Lod only", async () => {
    const source = sphere();
    const simplified = await simplify(source, { ratio: 0.05 });
    const lod = new Lod([source, simplified]);
    const [, level] = thresholds(lod);
    expect(level).toBeGreaterThan(1);
    expect(level).not.toBe(512);
    expect(thresholds(lod.clone())).toEqual(thresholds(lod));
    expect(thresholds(new Lod([sphere(), simplified.clone()]))).toEqual([Infinity, 512]);
  });

  it("raises defaults to leave room for the fades, never a value that was set", () => {
    const lod = new Lod([box(), box(), box()]);
    must(lod.levels[2]).maxPixels = 400;
    expect(thresholds(lod)).toEqual([Infinity, 800, 400]);
    must(lod.levels[1]).maxPixels = 300;
    expect(thresholds(lod)).toEqual([Infinity, 300, 400]);
    expect(() => lod.update(new PerspectiveCamera())).toThrow(/level 2 has maxPixels 400, but at most 270/);
  });
});

it("uses the nearest installed finer level before any coarser fallback, including a lazy source", () => {
  const deferred = (maxPixels: number) => new LazyLevel(async () => box(), { maxPixels, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) });
  const source = deferred(Infinity);
  const fine = box();
  const middle = deferred(100);
  const coarse = box();
  const objects = [source, fine, middle, coarse];
  expect(fallbacks(objects)).toEqual([1, 1, 1, 3]);
  expect(fallbacks(objects, new Set([source]))).toEqual([0, 1, 1, 3]);
  expect(() => new Lod([source])).toThrow("at least one level must be eager");
  expect(() => new InstancedLod([source], 1)).toThrow("at least one level must be eager");
  const lod = new Lod(objects);
  lod.forceLevel = 0;
  lod.update(new PerspectiveCamera());
  expect(source.visible).toBe(false);
  expect(fine.visible).toBe(true);
  lod.dispose();
});

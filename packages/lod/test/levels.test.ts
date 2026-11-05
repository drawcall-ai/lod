import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, RGBAFormat, Scene, SphereGeometry } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import type { Impostor } from "../src/impostor/impostor.js";
import { ImpostorMesh } from "../src/impostor/mesh/index.js";
import { InstancedLod } from "../src/instanced/index.js";
import { Lod } from "../src/lod.js";
import { simplify } from "../src/simplify.js";
import { Level, demandLevels, estimate, type LodLevel } from "../src/levels.js";
import { must } from "./must.js";

const box = () => new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial());
const sphere = () => new Mesh(new SphereGeometry(1, 64, 32), new MeshStandardMaterial());
const thresholds = (lod: { levels: ReadonlyArray<{ maxPixels: number }> }) => lod.levels.map((level) => level.maxPixels);

/** An impostor of a 2-unit box seen whole in frames of 4 texels: two texels span a pixel at 4 × r / (2 × 1.5) px. */
const impostor = (): Impostor => ({
  version: 4,
  layout: "full",
  frames: 4,
  size: 16,
  box: [-1, 0, -1, 1, 2, 1],
  halfSize: 1.5,
  maps: ["base", "normalDepth", "orm"],
  layers: [0, 1, 2].map(() => ({ format: RGBAFormat, mipmaps: [16, 8, 4].map((size) => new Uint8Array(size * size * 4)) })),
});

describe("default maxPixels", () => {
  it("puts an impostor where two atlas texels span a pixel", () => {
    const [, level] = thresholds(new Lod([{ object: box() }, { object: new ImpostorMesh(impostor()) }]));
    expect(level).toBeCloseTo((4 * Math.sqrt(3)) / 3, 9);
  });

  it("puts a simplified level where its deviation reaches a pixel, and keeps it in a cloned Lod only", async () => {
    const source = sphere();
    const simplified = await simplify(source, { ratio: 0.05 });
    const lod = new Lod([{ object: source }, { object: simplified }]);
    const [, level] = thresholds(lod);
    expect(level).toBeGreaterThan(1);
    expect(level).not.toBe(512);
    expect(thresholds(lod.clone())).toEqual(thresholds(lod));
    expect(thresholds(new Lod([{ object: sphere() }, { object: simplified.clone() }]))).toEqual([Infinity, 512]);
  });

  it("raises defaults to leave room for the fades, never a value that was set", () => {
    const lod = new Lod([{ object: box() }, { object: box() }, { object: box() }]);
    must(lod.levels[2]).maxPixels = 400;
    expect(thresholds(lod)).toEqual([Infinity, 800, 400]);
    must(lod.levels[1]).maxPixels = 300;
    expect(thresholds(lod)).toEqual([Infinity, 300, 400]);
    // An update runs inside three's render: it reports what fails rather than throwing.
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    lod.update(new PerspectiveCamera());
    report.mockRestore();
    expect(lod.error?.message).toMatch(/level 2 has maxPixels 400, but at most 270/);
  });
});

it("stands in the nearest ready coarser level that draws for a missing one, never a finer one", () => {
  const deferred = (maxPixels: number) => ({ load: async () => box(), maxPixels, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) });
  const drawn = (lod: Lod, force: number) => {
    // Missing levels outside any Scene are a failure: none of its renders would load them.
    if (!lod.parent) new Scene().add(lod);
    lod.forceLevel = force;
    lod.update(new PerspectiveCamera());
    return lod.levels.flatMap(({ object }, i) => (object?.visible ? [i] : []));
  };
  const input: LodLevel[] = [deferred(Infinity), { object: box() }, deferred(100), { object: box() }];
  const lod = new Lod(input);
  expect(drawn(lod, 0)).toEqual([1]);
  expect(drawn(lod, 2)).toEqual([3]);
  // An empty coarser level culls, so it never stands in; nor does the finer, costlier source.
  const culled = new Lod([{ object: box() }, deferred(100), { object: new Object3D(), maxPixels: 10 }]);
  expect(drawn(culled, 1)).toEqual([]);
  culled.dispose();
  must(lod.levels[2]).maxPixels = 50;
  const crowd = new InstancedLod(input, 1);
  expect(crowd.levels[2]?.maxPixels).toBe(100);
  expect(input[2]?.maxPixels).toBe(100);
  lod.dispose();
  crowd.dispose();
});

it("demands only the level a height draws, and its finer partner inside the fade", () => {
  const ladder: Level[] = [];
  for (const [index, input] of [{ object: new Group() }, { object: new Group(), maxPixels: 100 }].entries()) ladder.push(new Level(input, index, ladder));
  estimate(ladder, 1);
  // The finer level's fade starts at 90 px.
  expect(demandLevels(ladder, 85, null).map((level) => level.index)).toEqual([1]);
  expect(demandLevels(ladder, 95, null).map((level) => level.index)).toEqual([1, 0]);
});

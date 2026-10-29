import { Box3, BoxGeometry, Mesh, MeshStandardMaterial, PerspectiveCamera, SphereGeometry } from "three/webgpu";
import { describe, expect, it } from "vitest";
import type { Impostor } from "../src/impostor/impostor.js";
import { ImpostorMesh } from "../src/impostor/mesh/index.js";
import { InstancedLod } from "../src/instanced/index.js";
import { Lod } from "../src/lod.js";
import { simplify } from "../src/simplify.js";
import { type LodLevel } from "../src/levels.js";
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
    expect(() => lod.update(new PerspectiveCamera())).toThrow(/level 2 has maxPixels 400, but at most 270/);
  });
});

it("uses the nearest ready finer level before any coarser fallback", () => {
  const deferred = (maxPixels: number) => ({ load: async () => box(), maxPixels, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) });
  const input: LodLevel[] = [deferred(Infinity), { object: box() }, deferred(100), { object: box() }];
  const lod = new Lod(input);
  for (const force of [0, 2]) {
    lod.forceLevel = force;
    lod.update(new PerspectiveCamera());
    expect(lod.levels.map(({ object }) => object?.visible)).toEqual([undefined, true, undefined, false]);
  }
  must(lod.levels[2]).maxPixels = 50;
  const crowd = new InstancedLod(input, 1);
  expect(crowd.levels[2]?.maxPixels).toBe(100);
  expect(input[2]?.maxPixels).toBe(100);
  lod.dispose();
  crowd.dispose();
});

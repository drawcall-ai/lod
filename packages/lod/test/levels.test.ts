import { BoxGeometry, Mesh, MeshStandardMaterial, PerspectiveCamera, SphereGeometry } from "three";
import { describe, expect, it } from "vitest";
import type { Impostor } from "../src/impostor/impostor.js";
import { ImpostorMesh } from "../src/impostor/mesh/index.js";
import { InstancedLod } from "../src/instanced/index.js";
import { Lod } from "../src/lod.js";
import { simplify } from "../src/simplify.js";
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
  it("halves from 512 px for levels whose error is unknown", () => {
    expect(thresholds(new Lod([box(), box(), box(), box()]))).toEqual([Infinity, 512, 256, 128]);
  });

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

  it("works the same for an InstancedLod", () => {
    const [source, level, next] = thresholds(new InstancedLod([box(), new ImpostorMesh(impostor()), box()], 1));
    expect(source).toBe(Infinity);
    expect(level).toBeCloseTo((4 * Math.sqrt(3)) / 3, 9);
    expect(next).toBeCloseTo((2 * Math.sqrt(3)) / 3, 9);
  });

  it("refuses to set level 0 or a value that is not positive", () => {
    const lod = new Lod([box(), box()]);
    expect(() => (must(lod.levels[0]).maxPixels = 100)).toThrow(/level 0/);
    expect(() => (must(lod.levels[1]).maxPixels = 0)).toThrow(/> 0/);
    expect(() => (must(lod.levels[1]).maxPixels = NaN)).toThrow(/> 0/);
  });
});

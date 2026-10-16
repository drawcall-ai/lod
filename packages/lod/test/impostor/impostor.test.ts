import { describe, expect, it } from "vitest";
import { validateImpostor, type Impostor } from "../../src/impostor/impostor.js";

/** A mip chain of a 16-texel atlas of 4 frames: 16, 8 and 4 texels square. */
const chain = <T>(level: (size: number) => T) => [16, 8, 4].map(level);
const bytes = (size: number) => new Uint8Array(size * size * 4);

const valid: Impostor = {
  version: 3,
  layout: "hemi",
  frames: 4,
  size: 16,
  box: [-1, 0, -1, 1, 2, 1],
  halfSize: 1.5,
  maps: ["base", "normalDepth", "orm"],
  layers: [0, 1, 2].map(() => chain(bytes)),
};

describe("validateImpostor", () => {
  it.each([
    ["the base case", {}],
    ["an emissive layer", { maps: ["base", "normalDepth", "orm", "emissive"], layers: [0, 1, 2, 3].map(() => chain(bytes)) }],
    ["a flat box", { box: [-1, 0, -1, 1, 0, 1] }],
  ])("accepts %s", (_, change) => {
    expect(() => validateImpostor({ ...valid, ...change })).not.toThrow();
  });

  it.each([
    ["no object", null, /not an object/],
    ["another version", { version: 1 }, /unsupported version/],
    ["an unknown layout", { layout: "cube" }, /unknown layout/],
    ["too few frames", { frames: 1 }, /frames must be/],
    ["fractional frames", { frames: 2.5 }, /frames must be/],
    ["a zero size", { size: 0 }, /positive multiple/],
    ["a size not divisible by frames", { size: 18 }, /positive multiple/],
    ["frames not a power of two in size", { size: 24 }, /power of two/],
    ["a short box", { box: [0, 0, 0] }, /box must be/],
    ["a box with NaN", { box: [0, 0, 0, 1, NaN, 1] }, /box must be/],
    ["a box whose min exceeds its max", { box: [1, 0, -1, -1, 2, 1] }, /box min/],
    ["a zero halfSize", { halfSize: 0 }, /halfSize/],
    ["a string halfSize", { halfSize: "1.5" }, /halfSize/],
    ["maps out of order", { maps: ["base", "orm", "normalDepth"] }, /maps must be/],
    ["an unknown map", { maps: ["base", "normalDepth", "height"] }, /maps must be/],
    ["names joined into one map", { maps: ["base", "normalDepth,orm", "emissive"] }, /maps must be/],
    ["a missing orm map", { maps: ["base", "normalDepth"], layers: [] }, /maps must be/],
    ["a missing layer", { layers: [chain(bytes)] }, /one layer per map/],
    ["a missing mip level", { layers: [0, 1, 2].map(() => chain(bytes).slice(0, 2)) }, /mip chain of 3 levels/],
    ["a short level", { layers: [0, 1, 2].map(() => chain(() => new Uint8Array(4))) }, /level 0 must be a Uint8Array of 1024 bytes/],
    ["a non-byte level", { layers: [0, 1, 2].map(() => chain((size) => new Float32Array(size * size * 4))) }, /Uint8Array/],
  ])("rejects %s", (_, change, error) => {
    expect(() => validateImpostor(change === null ? null : { ...valid, ...change })).toThrow(error);
  });
});

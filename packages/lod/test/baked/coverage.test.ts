import { expect, it } from "vitest";
import { keepCoverage } from "../../src/baked/coverage.js";
import type { Mip } from "../../src/source/texels.js";

function mip(alphas: number[]): Mip {
  return { data: Uint8ClampedArray.from(alphas.flatMap((alpha) => [255, 255, 255, alpha])), width: alphas.length, height: 1 };
}

const alphas = (mip: Mip) => Array.from(mip.data).filter((_, i) => i % 4 === 3);

it("leaves a filtering margin between retained and rejected alpha values", () => {
  const binary = mip([0, 255]);
  const quantized = mip([64, 128]);
  keepCoverage([mip([0, 255, 0, 255]), binary, quantized]);
  expect(alphas(binary)).toEqual([0, 255]);
  expect(alphas(quantized)).toEqual([85, 170]);
});

it("does not turn a uniform coarse mip opaque or invent coverage from zero", () => {
  const uniform = mip([64]);
  const empty = mip([0]);
  const faint = mip([1]);
  keepCoverage([mip([255, 0, 0, 0]), uniform, empty, faint]);
  expect(alphas(uniform)).toEqual([128]);
  expect(alphas(empty)).toEqual([0]);
  expect(alphas(faint)).toEqual([8]);
  const opaque = mip([255]);
  keepCoverage([mip([255, 255]), opaque]);
  expect(alphas(opaque)).toEqual([255]);
});

import { describe, expect, it } from "vitest";
import { frameBasis, frameDirection, octDecode, octEncode, type Vec3 } from "../../src/impostor/octahedral.js";
import type { ImpostorLayout } from "../../src/impostor/impostor.js";

const LAYOUTS: ImpostorLayout[] = ["hemi", "full"];
const STEPS = 64;

function grid(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= STEPS; i++) for (let j = 0; j <= STEPS; j++) out.push([i / STEPS, j / STEPS]);
  return out;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function expectVec(actual: Vec3, expected: Vec3): void {
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 6));
}

describe("octEncode / octDecode", () => {
  for (const layout of LAYOUTS) {
    it(`${layout}: decoding gives unit directions that encode back to themselves`, () => {
      for (const [u, v] of grid()) {
        const d = octDecode(layout, u, v);
        expect(Math.hypot(...d)).toBeCloseTo(1, 9);
        const [eu, ev] = octEncode(layout, d);
        expectVec(octDecode(layout, eu, ev), d);
      }
    });
  }

  it("hemi: grid positions round trip everywhere", () => {
    for (const [u, v] of grid()) {
      const [eu, ev] = octEncode("hemi", octDecode("hemi", u, v));
      expect(eu).toBeCloseTo(u, 9);
      expect(ev).toBeCloseTo(v, 9);
    }
  });

  it("full: grid positions round trip off the seam", () => {
    // On the map's edge mirrored positions name the same direction, so only directions round trip there.
    for (const [u, v] of grid()) {
      if (u === 0 || v === 0 || u === 1 || v === 1) continue;
      const [eu, ev] = octEncode("full", octDecode("full", u, v));
      expect(eu).toBeCloseTo(u, 9);
      expect(ev).toBeCloseTo(v, 9);
    }
  });

  it("hemi: directions below the horizon clamp onto it", () => {
    const [u, v] = octEncode("hemi", [0.6, -0.8, 0]);
    expect(octDecode("hemi", u, v)[1]).toBeCloseTo(0, 9);
  });
});

describe("frameDirection", () => {
  it("hemi: the outer frames lie on the horizon", () => {
    for (const frames of [2, 7, 12, 16]) {
      for (let k = 0; k < frames; k++) {
        for (const [col, row] of [
          [k, 0],
          [k, frames - 1],
          [0, k],
          [frames - 1, k],
        ] as const)
          expect(frameDirection("hemi", frames, col, row)[1]).toBeCloseTo(0, 9);
      }
    }
  });

  it("hemi: inner frames look from above", () => {
    const frames = 12;
    for (let row = 1; row < frames - 1; row++)
      for (let col = 1; col < frames - 1; col++) expect(frameDirection("hemi", frames, col, row)[1]).toBeGreaterThan(0);
  });
});

describe("frameBasis", () => {
  const directions: Vec3[] = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0, 0, -1], ...LAYOUTS.flatMap((layout) => grid().map(([u, v]) => octDecode(layout, u, v)))];

  it("is orthonormal and right-handed, cross(tangent, bitangent) = n", () => {
    // Include the band next to the poles, where the basis switches tangent rules.
    const nearPoles: Vec3[] = [0.9991, 0.9995, 0.99999].flatMap((y) =>
      [0, 1, 2, 3].map((k): Vec3 => {
        const r = Math.sqrt(1 - y * y);
        return [r * Math.cos(k), y, r * Math.sin(k)];
      }),
    );
    for (const n of [...directions, ...nearPoles]) {
      const { tangent: t, bitangent: b } = frameBasis(n);
      expect(Math.hypot(...t)).toBeCloseTo(1, 9);
      expect(Math.hypot(...b)).toBeCloseTo(1, 9);
      expect(dot(t, b)).toBeCloseTo(0, 9);
      expect(dot(t, n)).toBeCloseTo(0, 9);
      expect(dot(b, n)).toBeCloseTo(0, 9);
      expectVec(cross(t, b), n);
    }
  });

  it("keeps world up on screen up away from the poles", () => {
    for (const n of directions) {
      if (Math.abs(n[1]) > 0.999) continue;
      expect(frameBasis(n).bitangent[1]).toBeGreaterThanOrEqual(0);
    }
  });
});

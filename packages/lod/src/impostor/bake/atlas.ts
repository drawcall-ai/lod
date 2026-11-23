import type { ImpostorMap } from "../impostor.js";

// Typed-array reads below are in bounds; their `?? 0` only answers noUncheckedIndexedAccess.

const toSrgb = (c: number): number => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * One mip of the atlas being baked: one RGBA8 layer per map, plus each texel's coverage.
 * The bake stores the normals two ways (see its materials): the maps hold the surface's
 * own normals, `turned` the shading normals turned toward the camera, each with the share
 * of the surface that shades with the normal rather than its opposite (in orm.a). One way
 * serves the whole impostor, as texels filtered together must mean the same thing.
 * With `specular`, the bake also writes each surface's dielectric specular, of which only
 * the coverage-weighted sum is stored, for its mean.
 */
export class ImpostorAtlasMip {
  readonly size: number;
  readonly layers: Uint8Array[];
  readonly coverage: Float32Array;
  /** Turned normal in RGB, the share of the surface that shades with it in A. */
  readonly turned: Uint8Array;
  /** How far each way's normals agree, summed over the texels by coverage: the averages' lengths. */
  readonly agreement = { own: 0, turned: 0 };
  /** F0 RGB and F90 summed over the texels by coverage, and the coverage summed. */
  private readonly specularSum = { value: [0, 0, 0, 0], coverage: 0 };

  constructor(
    readonly maps: ImpostorMap[],
    readonly frames: number,
    readonly cell: number,
    readonly specular: boolean,
  ) {
    this.size = frames * cell;
    this.layers = maps.map(() => new Uint8Array(this.size * this.size * 4));
    this.coverage = new Float32Array(this.size * this.size);
    this.turned = new Uint8Array(this.size * this.size * 4);
  }

  /** Use the turned normals: write them over the own normals and their shares. */
  useTurned(): void {
    const normalDepth = this.layer("normalDepth");
    const orm = this.layer("orm");
    for (let i = 0; i < this.turned.length; i += 4) {
      for (let k = 0; k < 3; k++) normalDepth[i + k] = this.turned[i + k] ?? 0;
      orm[i + 3] = this.turned[i + 3] ?? 0;
    }
  }

  private layer(map: ImpostorMap): Uint8Array {
    const layer = this.layers[this.maps.indexOf(map)];
    if (!layer) throw new Error(`ImpostorAtlasMip: no ${map} layer`);
    return layer;
  }

  /**
   * The sums of one supersampled frame at this mip's cell size: the `cell * ss` square at (x0, y0) of `pixels[m]`, map m
   * as RGBA floats `width` wide, then the turned normals, then the specular if baked.
   */
  sum(pixels: Float32Array[], width: number, ss: number, x0: number, y0: number): FrameSums {
    const { cell, maps } = this;
    const [alpha] = pixels;
    if (!alpha || pixels.length !== maps.length + (this.specular ? 2 : 1))
      throw new Error("ImpostorAtlasMip.sum: one pixel array per map, then the turned normals, then the specular if baked");
    const weight = new Float64Array(cell * cell);
    const values = pixels.map(() => new Float64Array(cell * cell * 4));
    for (let y = 0; y < cell; y++)
      for (let x = 0; x < cell; x++) {
        const t = y * cell + x;
        const first = ((y0 + y * ss) * width + x0 + x * ss) * 4;
        let total = 0;
        for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) total += alpha[first + (sy * width + sx) * 4 + 3] ?? 0;
        weight[t] = total;
        if (total === 0) continue;
        pixels.forEach((source, m) => {
          let [r, g, b, a] = [0, 0, 0, 0];
          for (let sy = 0; sy < ss; sy++)
            for (let sx = 0; sx < ss; sx++) {
              const i = first + (sy * width + sx) * 4;
              const w = alpha[i + 3] ?? 0;
              r += (source[i] ?? 0) * w;
              g += (source[i + 1] ?? 0) * w;
              b += (source[i + 2] ?? 0) * w;
              a += (source[i + 3] ?? 0) * w;
            }
          values[m]?.set([r, g, b, a], t * 4);
        });
      }
    return { cell, samples: ss * ss, weight, values };
  }

  /**
   * Write cell (col, row) from `sums` of its frame at this mip's cell size. Every value is the coverage-weighted mean of
   * the texel's samples, so the silhouette's colour is the object's colour rather than a mix with the cleared
   * background; coverage itself is the plain mean.
   */
  write(sums: FrameSums, col: number, row: number): void {
    const { cell, size, maps, layers } = this;
    if (sums.cell !== cell) throw new Error(`ImpostorAtlasMip.write: sums of ${sums.cell} px frames for a mip of ${cell} px frames`);
    const { samples, weight, values } = sums;
    const sources = [...maps, "turned" as const];
    const specular = this.specular ? values[maps.length + 1] : undefined;
    for (let y = 0; y < cell; y++)
      for (let x = 0; x < cell; x++) {
        const t = y * cell + x;
        const out = ((row * cell + y) * size + col * cell + x) * 4;
        const total = weight[t] ?? 0;
        const cover = total / samples;
        this.coverage[out / 4] = cover;
        if (total === 0) continue;
        const mean = (source: Float64Array): [number, number, number, number] => [
          (source[t * 4] ?? 0) / total,
          (source[t * 4 + 1] ?? 0) / total,
          (source[t * 4 + 2] ?? 0) / total,
          (source[t * 4 + 3] ?? 0) / total,
        ];
        if (specular) {
          const sum = this.specularSum;
          sum.value = mean(specular).map((v, k) => (sum.value[k] ?? 0) + cover * v);
          sum.coverage += cover;
        }
        sources.forEach((map, m) => {
          const source = values[m];
          const layer = map === "turned" ? this.turned : layers[m];
          if (!source || !layer) throw new Error(`ImpostorAtlasMip.write: no sums for ${map}`);
          const [r, g, b, a] = mean(source);
          if (map === "normalDepth") this.agreement.own += cover * Math.hypot(r * 2 - 1, g * 2 - 1, b * 2 - 1);
          if (map === "turned") this.agreement.turned += cover * Math.hypot(r * 2 - 1, g * 2 - 1, b * 2 - 1);
          store(layer, out, [r, g, b, map === "base" ? cover : a], map === "base" || map === "emissive");
        });
      }
  }

  /** The coverage-weighted mean of the baked specular: F0 RGB, then F90. */
  meanSpecular(): [number, number, number, number] {
    const { value, coverage } = this.specularSum;
    if (!this.specular || coverage === 0) throw new Error("ImpostorAtlasMip.meanSpecular: no specular was baked");
    const [r = 0, g = 0, b = 0, f90 = 0] = value.map((v) => v / coverage);
    return [r, g, b, f90];
  }

  /** Whether any texel of any frame was covered. */
  covered(): boolean {
    return this.coverage.some((c) => c > 0);
  }

  /**
   * Give every uncovered texel of every cell the values of its nearest covered texel
   * (breadth-first, within the cell). Filtering and mips then only ever read the object's
   * own colours, normals and depths near the silhouette. Coverage stays zero.
   */
  fillGutters(): void {
    for (let row = 0; row < this.frames; row++) for (let col = 0; col < this.frames; col++) this.fillGutter(col, row);
  }

  private fillGutter(col: number, row: number): void {
    const { cell, size } = this;
    const x0 = col * cell;
    const y0 = row * cell;
    const filled = new Uint8Array(cell * cell);
    const queue = new Int32Array(cell * cell);
    let tail = 0;
    for (let y = 0; y < cell; y++)
      for (let x = 0; x < cell; x++)
        if ((this.coverage[(y0 + y) * size + x0 + x] ?? 0) > 0) {
          filled[y * cell + x] = 1;
          queue[tail++] = y * cell + x;
        }
    for (let head = 0; head < tail; head++) {
      const p = queue[head] ?? 0;
      const px = p % cell;
      const py = (p - px) / cell;
      const from = ((y0 + py) * size + x0 + px) * 4;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = px + dx;
        const ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= cell || ny >= cell || filled[ny * cell + nx]) continue;
        filled[ny * cell + nx] = 1;
        queue[tail++] = ny * cell + nx;
        const to = ((y0 + ny) * size + x0 + nx) * 4;
        // Base coverage stays zero; the other layers' alpha is data (depth) and spreads too.
        this.layers.forEach((layer, m) => {
          const n = this.maps[m] === "base" ? 3 : 4;
          for (let k = 0; k < n; k++) layer[to + k] = layer[from + k] ?? 0;
        });
        for (let k = 0; k < 4; k++) this.turned[to + k] = this.turned[from + k] ?? 0;
      }
    }
  }
}

/**
 * One `cell`-square frame's texels as sums of their samples: per texel the coverage summed, and per source (each map,
 * then the turned normals, then the specular if baked) each RGBA channel times its sample's coverage, summed.
 */
export interface FrameSums {
  cell: number;
  /** Samples each texel sums. */
  samples: number;
  weight: Float64Array;
  values: Float64Array[];
}

/** The frame's sums at the next mip's cell size: each texel sums 2 × 2 texels of `sums`. */
export function halve({ cell, samples, weight, values }: FrameSums): FrameSums {
  const half = cell / 2;
  const sum = (from: Float64Array, channels: number) => {
    const out = new Float64Array(half * half * channels);
    for (let y = 0; y < half; y++)
      for (let x = 0; x < half; x++)
        for (let k = 0; k < channels; k++) {
          const at = (dx: number, dy: number) => from[((2 * y + dy) * cell + 2 * x + dx) * channels + k] ?? 0;
          out[(y * half + x) * channels + k] = at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1);
        }
    return out;
  };
  return { cell: half, samples: samples * 4, weight: sum(weight, 1), values: values.map((v) => sum(v, 4)) };
}

/**
 * Pack one texel into `layer` at byte `out`: colour as sRGB if `srgb`, the rest linearly.
 * An averaged normal is not renormalised: its length says how far the normals it averages
 * agree, and is lit by. Renormalised, a texel of leaves facing every which way would light
 * as one smooth surface turned to the camera.
 */
function store(layer: Uint8Array, out: number, [r, g, b, a]: readonly [number, number, number, number], srgb: boolean): void {
  const encode = srgb ? toSrgb : (v: number) => Math.round(v * 255);
  layer[out] = encode(r);
  layer[out + 1] = encode(g);
  layer[out + 2] = encode(b);
  layer[out + 3] = Math.round(a * 255);
}

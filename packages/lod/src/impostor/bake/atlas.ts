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
 * is kept for the whole impostor, as texels filtered together must mean the same thing.
 */
export class Atlas {
  readonly size: number;
  readonly layers: Uint8Array[];
  readonly coverage: Float32Array;
  /** Turned normal in RGB, the share of the surface that shades with it in A. */
  readonly turned: Uint8Array;
  /** How far each way's normals agree, summed over the texels by coverage: the averages' lengths. */
  readonly agreement = { own: 0, turned: 0 };

  constructor(
    readonly maps: ImpostorMap[],
    readonly frames: number,
    readonly cell: number,
  ) {
    this.size = frames * cell;
    this.layers = maps.map(() => new Uint8Array(this.size * this.size * 4));
    this.coverage = new Float32Array(this.size * this.size);
    this.turned = new Uint8Array(this.size * this.size * 4);
  }

  /** Keep the turned normals: write them over the own normals and their shares. */
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
    if (!layer) throw new Error(`Atlas: no ${map} layer`);
    return layer;
  }

  /**
   * Box-filter one supersampled frame into cell (col, row): the `cell * ss` square at
   * (x0, y0) of `pixels[m]`, map m as RGBA floats `width` wide, then the turned normals.
   * Every value is weighted by coverage, so the silhouette's colour is the object's colour
   * rather than a mix with the cleared background; coverage itself is the plain average.
   */
  write(pixels: Float32Array[], width: number, ss: number, col: number, row: number, x0: number, y0: number): void {
    const { cell, size, maps, layers } = this;
    const [alpha] = pixels;
    if (!alpha || pixels.length !== maps.length + 1) throw new Error("Atlas.write: one pixel array per map, then the turned normals");
    const sources = [...maps, "turned" as const];
    for (let y = 0; y < cell; y++)
      for (let x = 0; x < cell; x++) {
        const out = ((row * cell + y) * size + col * cell + x) * 4;
        const first = ((y0 + y * ss) * width + x0 + x * ss) * 4;
        let weight = 0;
        for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) weight += alpha[first + (sy * width + sx) * 4 + 3] ?? 0;
        const cover = weight / (ss * ss);
        this.coverage[out / 4] = cover;
        if (weight === 0) continue;
        sources.forEach((map, m) => {
          const source = pixels[m];
          const layer = map === "turned" ? this.turned : layers[m];
          if (!source || !layer) throw new Error(`Atlas.write: no pixels for ${map}`);
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          for (let sy = 0; sy < ss; sy++)
            for (let sx = 0; sx < ss; sx++) {
              const i = first + (sy * width + sx) * 4;
              const w = alpha[i + 3] ?? 0;
              r += (source[i] ?? 0) * w;
              g += (source[i + 1] ?? 0) * w;
              b += (source[i + 2] ?? 0) * w;
              a += (source[i + 3] ?? 0) * w;
            }
          [r, g, b, a] = [r / weight, g / weight, b / weight, a / weight];
          if (map === "normalDepth") this.agreement.own += cover * Math.hypot(r * 2 - 1, g * 2 - 1, b * 2 - 1);
          if (map === "turned") this.agreement.turned += cover * Math.hypot(r * 2 - 1, g * 2 - 1, b * 2 - 1);
          store(layer, out, [r, g, b, map === "base" ? cover : a], map === "base" || map === "emissive");
        });
      }
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
        // Base keeps zero coverage; the other layers' alpha is data (depth) and spreads too.
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
 * Pack one texel into `layer` at byte `out`: colour as sRGB if `srgb`, the rest linearly.
 * An averaged normal keeps its length, which says how far the normals it averages agree
 * and is lit by: renormalised, a texel of leaves facing every which way would light as one
 * smooth surface turned to the camera.
 */
function store(layer: Uint8Array, out: number, [r, g, b, a]: readonly [number, number, number, number], srgb: boolean): void {
  const encode = srgb ? toSrgb : (v: number) => Math.round(v * 255);
  layer[out] = encode(r);
  layer[out + 1] = encode(g);
  layer[out + 2] = encode(b);
  layer[out + 3] = Math.round(a * 255);
}

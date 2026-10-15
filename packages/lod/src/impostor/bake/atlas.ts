import type { ImpostorMap } from "../impostor.js";

// Typed-array reads below are in bounds; their `?? 0` only answers noUncheckedIndexedAccess.

const toSrgb = (c: number): number => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** One mip of the atlas being baked: one RGBA8 layer per map, plus each texel's coverage. */
export class Atlas {
  readonly size: number;
  readonly layers: Uint8Array[];
  readonly coverage: Float32Array;

  constructor(
    readonly maps: ImpostorMap[],
    readonly frames: number,
    readonly cell: number,
  ) {
    this.size = frames * cell;
    this.layers = maps.map(() => new Uint8Array(this.size * this.size * 4));
    this.coverage = new Float32Array(this.size * this.size);
  }

  /**
   * Box-filter one supersampled frame into cell (col, row): the `cell * ss` square at
   * (x0, y0) of `pixels[m]`, map m as RGBA floats `width` wide. Every value is weighted by
   * coverage, so the silhouette's colour is the object's colour rather than a mix with
   * the cleared background; coverage itself is the plain average.
   */
  write(pixels: Float32Array[], width: number, ss: number, col: number, row: number, x0: number, y0: number): void {
    const { cell, size, maps, layers } = this;
    const [alpha] = pixels;
    if (!alpha || pixels.length !== maps.length) throw new Error("Atlas.write: one pixel array per map");
    for (let y = 0; y < cell; y++)
      for (let x = 0; x < cell; x++) {
        const out = ((row * cell + y) * size + col * cell + x) * 4;
        const first = ((y0 + y * ss) * width + x0 + x * ss) * 4;
        let weight = 0;
        for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) weight += alpha[first + (sy * width + sx) * 4 + 3] ?? 0;
        const cover = weight / (ss * ss);
        this.coverage[out / 4] = cover;
        if (weight === 0) continue;
        for (let m = 0; m < maps.length; m++) {
          const source = pixels[m];
          const layer = layers[m];
          const map = maps[m];
          if (!source || !layer || !map) throw new Error(`Atlas.write: no pixels for map ${m}`);
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
          store(map, layer, out, r / weight, g / weight, b / weight, map === "base" ? cover : a / weight);
        }
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
        for (let m = 0; m < this.layers.length; m++) {
          const layer = this.layers[m];
          if (!layer) continue;
          const n = this.maps[m] === "base" ? 3 : 4;
          for (let k = 0; k < n; k++) layer[to + k] = layer[from + k] ?? 0;
        }
      }
    }
  }
}

/** Pack one texel of `map` into `layer` at byte `out`. */
function store(map: ImpostorMap, layer: Uint8Array, out: number, r: number, g: number, b: number, a: number): void {
  if (map === "base" || map === "emissive") {
    layer[out] = toSrgb(r);
    layer[out + 1] = toSrgb(g);
    layer[out + 2] = toSrgb(b);
  } else if (map === "normalDepth") {
    // Renormalise the averaged normal before packing.
    const nx = r * 2 - 1;
    const ny = g * 2 - 1;
    const nz = b * 2 - 1;
    const length = Math.hypot(nx, ny, nz) || 1;
    layer[out] = Math.round((nx / length) * 127.5 + 127.5);
    layer[out + 1] = Math.round((ny / length) * 127.5 + 127.5);
    layer[out + 2] = Math.round((nz / length) * 127.5 + 127.5);
  } else {
    layer[out] = Math.round(r * 255);
    layer[out + 1] = Math.round(g * 255);
    layer[out + 2] = Math.round(b * 255);
  }
  layer[out + 3] = Math.round(a * 255);
}

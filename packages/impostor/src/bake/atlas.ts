import type { ImpostorMap } from "../impostor.js";

const toSrgb = (c: number): number => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));

/** `array[i]`, throwing instead of returning undefined past the end. */
function at(array: ArrayLike<number>, i: number): number {
  const value = array[i];
  if (value === undefined) throw new RangeError(`Atlas: index ${i} out of range`);
  return value;
}

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** The atlas being baked: one RGBA8 layer per map, plus each texel's coverage. */
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
   * Box-filter one supersampled frame (`pixels[m]`: map m as RGBA floats, `cell * ss`
   * wide) into cell (col, row). Every value is weighted by coverage, so the silhouette's
   * colour is the object's colour rather than a mix with the cleared background;
   * coverage itself is the plain average.
   */
  write(pixels: Float32Array[], ss: number, col: number, row: number): void {
    const { cell, size } = this;
    const [alpha] = pixels;
    if (!alpha || pixels.length !== this.maps.length) throw new Error("Atlas.write: one pixel array per map");
    const width = cell * ss;
    for (let y = 0; y < cell; y++)
      for (let x = 0; x < cell; x++) {
        const out = ((row * cell + y) * size + col * cell + x) * 4;
        const first = (y * ss * width + x * ss) * 4;
        let weight = 0;
        for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) weight += at(alpha, first + (sy * width + sx) * 4 + 3);
        const cover = weight / (ss * ss);
        this.coverage[out / 4] = cover;
        if (weight === 0) continue;
        this.maps.forEach((map, m) => {
          const source = pixels[m];
          if (!source) throw new Error(`Atlas.write: no pixels for ${map}`);
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          for (let sy = 0; sy < ss; sy++)
            for (let sx = 0; sx < ss; sx++) {
              const i = first + (sy * width + sx) * 4;
              const w = at(alpha, i + 3);
              r += at(source, i) * w;
              g += at(source, i + 1) * w;
              b += at(source, i + 2) * w;
              a += at(source, i + 3) * w;
            }
          this.store(map, m, out, r / weight, g / weight, b / weight, map === "base" ? cover : a / weight);
        });
      }
  }

  private store(map: ImpostorMap, m: number, out: number, r: number, g: number, b: number, a: number): void {
    const layer = this.layers[m];
    if (!layer) throw new Error(`Atlas: no layer ${m}`);
    if (map === "base" || map === "emissive") layer.set([toSrgb(r), toSrgb(g), toSrgb(b)], out);
    else if (map === "normalDepth") {
      // Renormalise the averaged normal before packing.
      const [nx, ny, nz] = [r * 2 - 1, g * 2 - 1, b * 2 - 1];
      const length = Math.hypot(nx, ny, nz) || 1;
      const pack = (v: number) => Math.round((v / length) * 127.5 + 127.5);
      layer.set([pack(nx), pack(ny), pack(nz)], out);
    } else layer.set([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)], out);
    layer[out + 3] = Math.round(a * 255);
  }

  /** Whether any texel of any frame was covered. */
  covered(): boolean {
    return this.coverage.some((c) => c > 0);
  }

  /**
   * Give every uncovered texel of every cell the values of its nearest covered texel
   * (breadth-first, within the cell). Filtering and mip levels then only ever read the
   * object's own colours, normals and depths near the silhouette. Coverage stays zero.
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
        if (at(this.coverage, (y0 + y) * size + x0 + x) > 0) {
          filled[y * cell + x] = 1;
          queue[tail++] = y * cell + x;
        }
    for (let head = 0; head < tail; head++) {
      const p = at(queue, head);
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
        this.layers.forEach((layer, m) => layer.copyWithin(to, from, from + (this.maps[m] === "base" ? 3 : 4)));
      }
    }
  }
}

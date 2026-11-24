import type { ImpostorMap } from "../impostor.js";
import type { BakedMip } from "./sheet.js";

// Typed-array reads below are in bounds; their `?? 0` only answers noUncheckedIndexedAccess.

/**
 * One mip of the atlas being baked, as the GPU averaged it (see `bakeAtlas`): one RGBA8 layer per map, base's alpha the
 * texel's coverage. The bake stores the normals two ways (see its materials): the maps hold the surface's own normals,
 * `turned` the shading normals turned toward the camera, each with the share of the surface that shades with the
 * normal rather than its opposite (in orm.a). One way serves the whole impostor, as texels filtered together must mean
 * the same thing.
 */
export class ImpostorAtlasMip {
  readonly size: number;
  readonly layers: Uint8Array[];
  readonly turned: Uint8Array;

  constructor(
    readonly maps: readonly ImpostorMap[],
    readonly frames: number,
    readonly cell: number,
    { layers, turned }: BakedMip,
  ) {
    this.size = frames * cell;
    this.layers = layers;
    this.turned = turned;
  }

  private layer(map: ImpostorMap): Uint8Array {
    const layer = this.layers[this.maps.indexOf(map)];
    if (!layer) throw new Error(`ImpostorAtlasMip: no ${map} layer`);
    return layer;
  }

  /** Each texel's coverage, 0..255. */
  private coverage(texel: number): number {
    return this.layer("base")[texel * 4 + 3] ?? 0;
  }

  /** Whether any texel of any frame was covered. */
  covered(): boolean {
    for (let t = 0; t < this.size * this.size; t++) if (this.coverage(t) > 0) return true;
    return false;
  }

  /**
   * How far each way's normals agree, summed over the texels by coverage: the lengths of the averaged normals, which
   * averaging normals that point every which way shortens.
   */
  agreement(): { own: number; turned: number } {
    const own = this.layer("normalDepth");
    const length = (layer: Uint8Array, i: number) =>
      Math.hypot(((layer[i] ?? 0) / 255) * 2 - 1, ((layer[i + 1] ?? 0) / 255) * 2 - 1, ((layer[i + 2] ?? 0) / 255) * 2 - 1);
    const sum = { own: 0, turned: 0 };
    for (let t = 0; t < this.size * this.size; t++) {
      const cover = this.coverage(t) / 255;
      if (cover === 0) continue;
      sum.own += cover * length(own, t * 4);
      sum.turned += cover * length(this.turned, t * 4);
    }
    return sum;
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
}

/** The coverage-weighted mean of the top mip's `specular` (RGBA floats per texel: F0 RGB, then F90) over `top`. */
export function meanSpecular(specular: Float32Array, top: ImpostorAtlasMip): [number, number, number, number] {
  const base = top.layers[top.maps.indexOf("base")];
  if (!base) throw new Error("meanSpecular: no base layer");
  const sum = [0, 0, 0, 0];
  let coverage = 0;
  for (let t = 0; t < top.size * top.size; t++) {
    const cover = (base[t * 4 + 3] ?? 0) / 255;
    if (cover === 0) continue;
    for (let k = 0; k < 4; k++) sum[k] = (sum[k] ?? 0) + cover * (specular[t * 4 + k] ?? 0);
    coverage += cover;
  }
  if (coverage === 0) throw new Error("meanSpecular: nothing was covered");
  const [r = 0, g = 0, b = 0, f90 = 0] = sum.map((v) => v / coverage);
  return [r, g, b, f90];
}

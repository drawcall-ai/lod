import * as THREE from "three/webgpu";
import { EXTENT } from "./terrain.ts";

/** What covers the ground at a point, as far as ground cover (grass, flowers) cares. */
export const Use = {
  Lawn: 0,
  /** Roads, pavements, plazas and the footprints of houses: nothing grows. */
  Paved: 1,
  Field: 2,
  Forest: 3,
  /** Arable land under a crop other than corn (see `Crop`): no lawn grows there. */
  Crop: 4,
  Water: 5,
} as const;
export type Use = (typeof Use)[keyof typeof Use];
const USES: readonly Use[] = [Use.Lawn, Use.Paved, Use.Field, Use.Forest, Use.Crop, Use.Water];

/** What a farmland parcel holds; the terrain shader colours each (keep the numbers in step with content/terrain.ts). */
export const Crop = { None: 0, Pasture: 1, Wheat: 2, Rapeseed: 3, Ploughed: 4, Stubble: 5 } as const;
export type Crop = (typeof Crop)[keyof typeof Crop];

const RESOLUTION = 2;

/**
 * A raster of `Use` over the detailed square, 2 m per cell, lawn where nothing was painted;
 * on farmland also the parcel each cell belongs to and its crop.
 */
export class Land {
  readonly size = Math.round((2 * EXTENT) / RESOLUTION);
  private readonly cells = new Uint8Array(this.size * this.size);
  /** Per cell: crop, the parcel's tint (0–255), the parcel's row direction (0–255 over half a turn), the parcel id's low byte. */
  private readonly parcels = new Uint8Array(this.size * this.size * 4);

  at(x: number, z: number): Use {
    const i = Math.floor((x + EXTENT) / RESOLUTION);
    const j = Math.floor((z + EXTENT) / RESOLUTION);
    if (i < 0 || j < 0 || i >= this.size || j >= this.size) return Use.Lawn;
    const use = USES[this.cells[j * this.size + i] ?? -1];
    if (use === undefined) throw new Error("land raster holds an unknown use");
    return use;
  }

  /** The cell's index and centre for a point, or null outside the raster. */
  cell(x: number, z: number): number | null {
    const i = Math.floor((x + EXTENT) / RESOLUTION);
    const j = Math.floor((z + EXTENT) / RESOLUTION);
    return i < 0 || j < 0 || i >= this.size || j >= this.size ? null : j * this.size + i;
  }

  /** Centre of cell `k`. */
  centre(k: number): { x: number; z: number } {
    return { x: -EXTENT + ((k % this.size) + 0.5) * RESOLUTION, z: -EXTENT + (Math.floor(k / this.size) + 0.5) * RESOLUTION };
  }

  useOf(k: number): Use {
    const use = USES[this.cells[k] ?? -1];
    if (use === undefined) throw new Error("land raster holds an unknown use");
    return use;
  }

  /** Put cell `k` in a parcel: its crop, tint, row direction (radians) and id. */
  sow(k: number, crop: Crop, tint: number, angle: number, id: number): void {
    if (crop !== Crop.None && crop !== Crop.Pasture) this.cells[k] = Use.Crop;
    this.parcels.set([crop, Math.round(tint * 255), Math.round(((angle / Math.PI) % 1) * 255), id & 255], k * 4);
  }

  /** The parcel id's low byte at cell `k` (0 where no parcel was sown). */
  parcelOf(k: number): number {
    return this.parcels[k * 4 + 3] ?? 0;
  }

  /** The parcels as a texture over the detailed square: RGBA = crop, tint, row direction, use. */
  texture(): THREE.DataTexture {
    const data = new Uint8Array(this.parcels);
    for (let k = 0; k < this.cells.length; k++) data[k * 4 + 3] = this.cells[k] ?? 0;
    const t = new THREE.DataTexture(data, this.size, this.size, THREE.RGBAFormat);
    t.magFilter = t.minFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  }

  /** Paint every cell whose centre lies in the box and passes `inside` (world x, z). */
  paint(use: Use, minX: number, minZ: number, maxX: number, maxZ: number, inside: (x: number, z: number) => boolean): void {
    const i0 = Math.max(0, Math.floor((minX + EXTENT) / RESOLUTION));
    const j0 = Math.max(0, Math.floor((minZ + EXTENT) / RESOLUTION));
    const i1 = Math.min(this.size - 1, Math.floor((maxX + EXTENT) / RESOLUTION));
    const j1 = Math.min(this.size - 1, Math.floor((maxZ + EXTENT) / RESOLUTION));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = -EXTENT + (i + 0.5) * RESOLUTION;
        const z = -EXTENT + (j + 0.5) * RESOLUTION;
        if (inside(x, z)) this.cells[j * this.size + i] = use;
      }
  }

  /** Paint a strip `width` wide along the segment a–b. */
  strip(use: Use, ax: number, az: number, bx: number, bz: number, width: number): void {
    const half = width / 2;
    const dx = bx - ax;
    const dz = bz - az;
    const length2 = dx * dx + dz * dz;
    this.paint(use, Math.min(ax, bx) - half, Math.min(az, bz) - half, Math.max(ax, bx) + half, Math.max(az, bz) + half, (x, z) => {
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length2));
      return Math.hypot(x - ax - t * dx, z - az - t * dz) <= half;
    });
  }
}

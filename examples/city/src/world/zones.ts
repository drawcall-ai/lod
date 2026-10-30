import type { DataTexture } from "three/webgpu";

/** A round patch of forest floor: centre x, z, radius and the phase of its ragged edge and clearings, see `forestEdge`. */
export interface Forest {
  x: number;
  z: number;
  radius: number;
  phase: number;
}

/** Ground that is not lawn: corn fields (rotated rectangles), forest floor (round patches), farmland parcels. */
export interface Zones {
  /** Centre x, z, half size along the field's own x and z, and its turn about y (radians). */
  fields: { x: number; z: number; halfX: number; halfZ: number; angle: number }[];
  forests: Forest[];
  /**
   * Farmland parcels over the square ±`extent`, one texel per cell: RGBA8 = a `Crop`, the
   * parcel's tint, its row direction (over half a turn), the cell's `Use`. Null for none.
   */
  parcels: { texture: DataTexture; extent: number } | null;
  /** The town, whose lawns (lawn cells within `radius`) are mown in stripes along its grid (`angle`). */
  town: { x: number; z: number; radius: number; angle: number } | null;
}

/**
 * How far from its centre a forest of `radius` reaches in the direction `angle` (radians,
 * atan2(z, x)): stretched one way, lobed and ragged. The terrain shader repeats this
 * formula (see render/ground/shading.ts): placement and ground agree.
 */
export function forestEdge(radius: number, angle: number, phase: number): number {
  const stretch = 1 + 0.28 * Math.cos(2 * (angle - phase));
  const lobes =
    0.16 * Math.sin(3 * angle + phase) +
    0.09 * Math.sin(5 * angle + 2.3 * phase) +
    0.05 * Math.sin(11 * angle + 3 * phase) +
    0.025 * Math.sin(23 * angle + 5 * phase);
  return radius * stretch * (1 + lobes);
}

/** The forest's two clearings: centre x, z (relative to the forest's centre) and radius. */
export function forestClearings(radius: number, phase: number): { x: number; z: number; radius: number }[] {
  return [phase + 1, phase + 3.7].map((a, k) => ({
    x: Math.cos(a) * radius * (0.35 + 0.15 * k),
    z: Math.sin(a) * radius * (0.35 + 0.15 * k),
    radius: radius * (0.12 + 0.06 * k),
  }));
}

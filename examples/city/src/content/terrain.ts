import * as THREE from "three/webgpu";
import { cameraPosition, distance, positionWorld, vec4 } from "three/tsl";
import { groundShading } from "./ground.ts";
import { baseColor, once, texture } from "./materials.ts";

export type { Ground } from "./ground.ts";
export { groundShading } from "./ground.ts";

/** Ground that is not lawn: corn fields (rotated rectangles), forest floor (round patches), farmland parcels. */
export interface Zones {
  /** Centre x, z, half size along the field's own x and z, and its turn about y (radians). */
  fields: { x: number; z: number; halfX: number; halfZ: number; angle: number }[];
  /** Centre x, z, radius and the phase of its ragged edge and clearings, see `forestEdge`. */
  forests: { x: number; z: number; radius: number; phase: number }[];
  /**
   * Farmland parcels over the square ±`extent`, one texel per cell: RGBA8 = crop (1 pasture,
   * 2 wheat, 3 rapeseed, 4 ploughed, 5 stubble, 0 none), the parcel's tint, its row
   * direction (over half a turn), the cell's use (unused here). Null for none.
   */
  parcels: { texture: THREE.DataTexture; extent: number } | null;
  /** The town, whose lawns (lawn cells within `radius`) are mown in stripes along its grid (`angle`). */
  town: { x: number; z: number; radius: number; angle: number } | null;
}

/**
 * How far from its centre a forest of `radius` reaches in the direction `angle` (radians,
 * atan2(z, x)): stretched one way, lobed and ragged. The terrain shader repeats this
 * formula (see ground.ts): placement and ground agree.
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

/** The lawn everywhere, for the content viewer. */
export const terrain = once(() => terrainMaterial({ fields: [], forests: [], parcels: null, town: null }));

/** Ground for anything from a few metres to a few kilometres away, on a mesh whose UVs are world x/z in metres: see `groundShading`. */
export function terrainMaterial(zones: Zones): THREE.MeshStandardNodeMaterial {
  const lawn = "Grass001";
  const m = new THREE.MeshStandardNodeMaterial({
    name: "terrain",
    normalMap: texture(lawn, "nor"),
    // fully rough: the photo's roughness lets a low sun glare off the lawn like wet tarmac
    roughness: 1,
    aoMap: texture(lawn, "arm"),
    metalness: 0,
  });
  const ground = groundShading(zones);
  m.colorNode = baseColor.mul(vec4(ground(positionWorld.xz, distance(cameraPosition, positionWorld)), 1));
  return m;
}

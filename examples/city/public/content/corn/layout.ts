import * as THREE from "three/webgpu";
import { Random } from "../random.ts";

/** Edge of a corn block (m): 8 rows 0.75 m apart. */
export const BLOCK = 6;
export const ROWS = 8;
/** Mean distance between plants in a row (m). */
const SPACING = 0.18;
/** Which plant model each plant of a block is: one of this many, numbered from 0. */
export const VARIANTS = 4;
export const DESIGNS = 4;
export const HERO_VARIANT = 2;

/** A plant of a block design, in the block's frame: turned `yaw` about the vertical, after leaning `lean` (radians) about its own x axis. */
export interface Plant {
  variant: number;
  x: number;
  z: number;
  yaw: number;
  lean: number;
}

/**
 * One block design, sown as a planter sows: rows along x, 0.75 m apart, never quite
 * straight (each wanders a few centimetres over the block and is back on its line at the
 * block's ends, where the next block's row goes on); in the row, each plant 18 ± 6 cm
 * from the last, a few centimetres off the line, a few missing, a few doubled; every
 * plant turned any way and leaning a few degrees. No two rows keep in step, so no view,
 * least of all a bake's parallel rays, looks down long clean gaps between the plants.
 */
export function layout(design: number): Plant[] {
  const r = new Random(design + 11);
  const plants: Plant[] = [];
  const sow = (x: number, z: number) =>
    plants.push({ variant: r.int(0, VARIANTS - 1), x, z: z + r.range(-0.04, 0.04), yaw: r.range(0, 2 * Math.PI), lean: r.range(-0.07, 0.07) });
  for (let row = 0; row < ROWS; row++) {
    const line = -BLOCK / 2 + (row + 0.5) * (BLOCK / ROWS);
    const bends = [r.range(-0.04, 0.04), r.range(-0.02, 0.02), r.range(-0.012, 0.012)];
    const wander = (x: number) => bends.reduce((sum, a, k) => sum + a * Math.sin(((k + 1) * Math.PI * (x + BLOCK / 2)) / BLOCK), 0);
    for (let x = -BLOCK / 2 + r.range(0, SPACING); x < BLOCK / 2; x += SPACING * r.range(0.65, 1.35)) {
      if (r.chance(0.04)) continue;
      sow(x, line + wander(x));
      if (r.chance(0.03)) sow(x + r.range(0.04, 0.07), line + wander(x));
    }
  }
  return plants;
}

/** The turn of a plant standing `plant`, after the frame's own turn `yaw`. */
export function plantTurn(plant: Plant, yaw: number, target: THREE.Quaternion): THREE.Quaternion {
  return target.setFromEuler(new THREE.Euler(plant.lean, plant.yaw + yaw, 0, "YXZ"));
}

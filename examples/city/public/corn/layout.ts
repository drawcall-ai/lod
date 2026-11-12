import * as THREE from "three/webgpu";
import seedrandom from "seedrandom";

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
  const r = seedrandom(String(design + 11));
  const plants: Plant[] = [];
  const sow = (x: number, z: number) =>
    plants.push({ variant: Math.floor(VARIANTS * r()), x, z: z + (-0.04 + 0.08 * r()), yaw: 2 * Math.PI * r(), lean: -0.07 + 0.14 * r() });
  for (let row = 0; row < ROWS; row++) {
    const line = -BLOCK / 2 + (row + 0.5) * (BLOCK / ROWS);
    const bends = [-0.04 + 0.08 * r(), -0.02 + 0.04 * r(), -0.012 + 0.024 * r()];
    const wander = (x: number) => bends.reduce((sum, a, k) => sum + a * Math.sin(((k + 1) * Math.PI * (x + BLOCK / 2)) / BLOCK), 0);
    for (let x = -BLOCK / 2 + SPACING * r(); x < BLOCK / 2; x += SPACING * (0.65 + 0.7 * r())) {
      if (r() < 0.04) continue;
      sow(x, line + wander(x));
      if (r() < 0.03) sow(x + (0.04 + 0.03 * r()), line + wander(x));
    }
  }
  return plants;
}

/** The turn of a plant standing `plant`, after the frame's own turn `yaw`. */
export function plantTurn(plant: Plant, yaw: number, target: THREE.Quaternion): THREE.Quaternion {
  return target.setFromEuler(new THREE.Euler(plant.lean, plant.yaw + yaw, 0, "YXZ"));
}

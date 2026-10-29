import * as THREE from "three/webgpu";
import { InstancedLod, type LodLevel } from "@drawcall/lod";

/** Places instance `i` of `lod` at a spot: on the ground, turned and scaled. */
export function place(lod: InstancedLod, i: number, at: { x: number; y: number; z: number; angle: number; scale: number }): void {
  matrix.compose(position.set(at.x, at.y, at.z), turn.setFromAxisAngle(UP, at.angle), size.setScalar(at.scale));
  lod.setMatrixAt(i, matrix);
}

const UP = new THREE.Vector3(0, 1, 0);
const matrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const turn = new THREE.Quaternion();
const size = new THREE.Vector3();

/** Edge of the square regions copies are grouped in: each InstancedLod covers one, so whole regions out of view are culled. */
const REGION = 1000;

/**
 * Spreads `spots` over shared levels: one InstancedLod per variant and region. `tint`
 * gives each copy a colour, white for none.
 */
export function spread(
  name: string,
  variants: readonly (readonly LodLevel[])[],
  spots: { x: number; y: number; z: number; angle: number; scale: number }[],
  tint?: (i: number, color: THREE.Color) => THREE.Color,
): InstancedLod[] {
  const lods: InstancedLod[] = [];
  const color = new THREE.Color();
  const regions = variants.map(() => new Map<string, typeof spots>());
  for (const [index, at] of spots.entries()) {
    const variant = ((index * 2654435761) % 4294967296) % variants.length;
    const groups = regions[variant];
    if (!groups) throw new Error(`${name}: missing variant ${variant}`);
    const key = `${Math.floor(at.x / REGION)},${Math.floor(at.z / REGION)}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    group.push(at);
  }
  for (const [variant, groups] of regions.entries()) {
    const levels = variants[variant];
    if (!levels) throw new Error(`${name}: missing levels ${variant}`);
    for (const [key, group] of groups) {
      const lod = new InstancedLod(levels, group.length);
      lod.name = `${name} ${variant} ${key}`;
      group.forEach((at, index) => {
        place(lod, index, at);
        if (tint) lod.setColorAt(index, tint(Math.round(at.x * 7 + at.z * 13), color));
      });
      lods.push(lod);
    }
  }
  return lods;
}

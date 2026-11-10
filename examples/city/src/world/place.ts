import * as THREE from "three/webgpu";
import { InstancedLod, type LodGpu, type LodLevel } from "@drawcall/lod";

/** A spot on the ground, with the turn and scale of what stands there. */
export interface Spot {
  x: number;
  y: number;
  z: number;
  angle: number;
  scale: number;
}

/** Colours the copy at `at`, the `index`th of its spots, into `color`, which starts white. */
export type Tint = (at: Spot, index: number, color: THREE.Color) => THREE.Color;

/** `levels` standing at `spots` as one chunk: on the ground, turned and scaled, coloured by `tint` when given. */
export function instancedAt(gpu: LodGpu, name: string, levels: readonly LodLevel[], spots: readonly Spot[], tint?: Tint): InstancedLod {
  const lod = new InstancedLod(levels, gpu, { maxInstanceCount: spots.length });
  lod.name = name;
  const instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(spots.length * 16), 16);
  const instanceColor = tint ? new THREE.InstancedBufferAttribute(new Float32Array(spots.length * 3), 3) : undefined;
  spots.forEach((at, i) => {
    matrix.compose(position.set(at.x, at.y, at.z), turn.setFromAxisAngle(UP, at.angle), size.setScalar(at.scale)).toArray(instanceMatrix.array, i * 16);
    if (tint && instanceColor) tint(at, i, color.setRGB(1, 1, 1)).toArray(instanceColor.array, i * 3);
  });
  lod.addChunk({ instanceMatrix, instanceColor });
  return lod;
}

const UP = new THREE.Vector3(0, 1, 0);
const matrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const turn = new THREE.Quaternion();
const size = new THREE.Vector3();
const color = new THREE.Color();

/** Edge of the square regions copies are grouped in: each InstancedLod covers one, so whole regions out of view are culled. */
const REGION = 1000;

/**
 * Spreads `spots` over shared levels: one InstancedLod per variant and region. `tint`
 * gives each copy a colour, white for none.
 */
export function spread(
  gpu: LodGpu,
  name: string,
  variants: readonly (readonly LodLevel[])[],
  spots: Spot[],
  tint?: (i: number, color: THREE.Color) => THREE.Color,
): InstancedLod[] {
  const lods: InstancedLod[] = [];
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
    for (const [key, group] of groups)
      lods.push(instancedAt(gpu, `${name} ${variant} ${key}`, levels, group, tint && ((at, _, color) => tint(Math.round(at.x * 7 + at.z * 13), color))));
  }
  return lods;
}

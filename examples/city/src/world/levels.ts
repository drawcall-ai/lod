import * as THREE from "three";
import { cachedImpostor } from "./cache.ts";
import { bakeMesh, ImpostorMesh, type ImpostorMeshOptions, InstancedLod, type Lod, simplify } from "@drawcall/lod";

/**
 * Levels built in memory with the package's building blocks: content here is generated
 * or split out of model files. `maxPixels`, where given, sets the level's switch height;
 * elsewhere the package's default for the level applies.
 */
export interface Level {
  object: THREE.Object3D;
  maxPixels?: number;
}

/** Diameter of the sphere the package measures an object by: twice the half diagonal of its box. */
export function diameter(object: THREE.Object3D): number {
  return new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()).length();
}

export async function simplified(source: THREE.Object3D, ratio: number, maxPixels?: number): Promise<Level> {
  return { object: await simplify(source, { ratio }), maxPixels };
}

/** `source` baked onto `low`; with `interior` (inside the source), its windows show those rooms. */
export async function baked(source: THREE.Object3D, low: THREE.Object3D, textureSize: number, maxPixels?: number, interior?: THREE.Object3D): Promise<Level> {
  const object = await bakeMesh(source, { low, textureSize, interior });
  object.castShadow = object.receiveShadow = true;
  return { object, maxPixels };
}

/**
 * A hemispherical impostor (everything here stands upright), from the bake cache when
 * the same source was baked before: `resolution` pixels per view
 * over `frames` views per atlas side (the package's defaults where not given), drawn with `draw`.
 * Baked for `maxPixels` too: switch heights here are well above where an impostor is
 * sharp, and up to them it keeps the source's look at that height.
 */
export async function impostor(
  source: THREE.Object3D,
  options: { maxPixels?: number; resolution?: number; frames?: number; draw?: ImpostorMeshOptions } = {},
): Promise<Level> {
  const { maxPixels, resolution, frames, draw = {} } = options;
  const object = new ImpostorMesh(await cachedImpostor(source, { resolution, frames, maxPixels }), 1, draw);
  object.castShadow = object.receiveShadow = true;
  return { object, maxPixels };
}

/** Nothing: copies smaller than `maxPixels` on screen are not drawn at all. */
export function culled(maxPixels: number): Level {
  return { object: new THREE.Group(), maxPixels };
}

/** `count` instances of `source` with `levels` after it. */
export function instanced(name: string, source: THREE.Object3D, levels: Level[], count: number): InstancedLod {
  const lod = new InstancedLod([source, ...levels.map((l) => l.object)], count);
  lod.name = name;
  return thresholds(lod, levels);
}

/** Sets the given switch heights of a `Lod` or `InstancedLod` whose levels after the source are `levels`. */
export function thresholds<T extends Lod | InstancedLod>(lod: T, levels: Level[]): T {
  levels.forEach((level, i) => {
    const entry = lod.levels[i + 1];
    if (!entry) throw new Error(`${lod.name}: level ${i + 1} is missing`);
    if (level.maxPixels !== undefined) entry.maxPixels = level.maxPixels;
  });
  return lod;
}

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
 * Spreads `spots` over `variants`, with the levels `build` makes for each variant (built
 * once, however many copies stand): one InstancedLod per variant and region. `tint`
 * gives each copy a colour, white for none.
 */
export async function spread(
  name: string,
  variants: THREE.Object3D[],
  spots: { x: number; y: number; z: number; angle: number; scale: number }[],
  build: (source: THREE.Object3D) => Promise<Level[]>,
  tint?: (i: number, color: THREE.Color) => THREE.Color,
): Promise<InstancedLod[]> {
  const lods: InstancedLod[] = [];
  const color = new THREE.Color();
  for (const [v, source] of variants.entries()) {
    const mine = spots.filter((_, i) => ((i * 2654435761) % 4294967296) % variants.length === v);
    if (mine.length === 0) continue;
    const label = `${name} ${source.name}`;
    const levels = await build(source);
    const regions = new Map<string, typeof mine>();
    for (const at of mine) {
      const key = `${Math.floor(at.x / REGION)},${Math.floor(at.z / REGION)}`;
      regions.set(key, [...(regions.get(key) ?? []), at]);
    }
    for (const [key, group] of regions) {
      // levels are templates: each InstancedLod reads them, none adds them to the scene
      const lod = instanced(`${label} ${key}`, source, levels, group.length);
      group.forEach((at, i) => {
        place(lod, i, at);
        if (tint) lod.setColorAt(i, tint(Math.round(at.x * 7 + at.z * 13), color));
      });
      lods.push(lod);
    }
  }
  return lods;
}

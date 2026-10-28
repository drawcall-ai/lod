import * as THREE from "three/webgpu";
import { cachedImpostor } from "./cache.ts";
import type { Dependencies } from "vitecache";
import { bakeMesh, LazyImpostor, type ImpostorMeshOptions, InstancedLod, type Lod, simplify } from "@drawcall/lod";

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

/** A cached impostor, loaded only when this level is requested by a view. */
export function impostor(
  source: THREE.Object3D,
  options: {
    dependencies: Dependencies;
    maxPixels: number;
    resolution?: number;
    frames?: number;
    draw?: ImpostorMeshOptions;
    /** Houses consume their original geometry after building the source level. */
    snapshot?: boolean;
  },
): Level {
  const { dependencies, maxPixels, resolution, frames, draw = {} } = options;
  const owned = new Set<THREE.BufferGeometry>();
  let input: THREE.Object3D | undefined = source;
  if (options.snapshot) {
    input = source.clone();
    input.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      node.geometry = node.geometry.clone();
      owned.add(node.geometry);
    });
  }
  const object = new LazyImpostor(
    async () => {
      if (!input) throw new Error("An impostor source was released before loading");
      const result = await cachedImpostor(input, { layout: "hemi", resolution, frames, maxPixels }, dependencies);
      for (const geometry of owned) geometry.dispose();
      owned.clear();
      input = undefined;
      return result;
    },
    { maxPixels, draw },
  );
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
  build: (source: THREE.Object3D, variant: number) => Promise<Level[]>,
  tint?: (i: number, color: THREE.Color) => THREE.Color,
  regional = true,
): Promise<InstancedLod[]> {
  const lods: InstancedLod[] = [];
  const color = new THREE.Color();
  for (const [v, source] of variants.entries()) {
    const mine = spots.filter((_, i) => ((i * 2654435761) % 4294967296) % variants.length === v);
    if (mine.length === 0) continue;
    const label = `${name} ${source.name}`;
    const levels = await build(source, v);
    const regions = new Map<string, typeof mine>();
    for (const at of mine) {
      const key = `${Math.floor(at.x / REGION)},${Math.floor(at.z / REGION)}`;
      let group = regions.get(key);
      if (!group) regions.set(key, (group = []));
      group.push(at);
    }
    // Far impostors can share one crowd without changing the regions' slot order.
    const batches = regional ? regions : [["all", [...regions.values()].flat()] as const];
    for (const [key, group] of batches) {
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

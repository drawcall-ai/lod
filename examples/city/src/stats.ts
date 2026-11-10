import * as THREE from "three/webgpu";
import { InstancedLod, Lod } from "@drawcall/lod";

/** Per level: instances drawing it this frame and their triangles. */
export interface LevelCount {
  instances: number;
  triangles: number;
}

/**
 * Full instance scan for requested diagnostics, outside the live overlay and measured frames: the level each instance
 * draws for `camera`. Instances planted on the GPU are not counted: the CPU cannot see them.
 */
export function countLevels(roots: readonly THREE.Object3D[], camera: THREE.Camera): LevelCount[] {
  const lods: (Lod | InstancedLod)[] = [];
  for (const root of roots)
    root.traverse((node) => {
      if (node instanceof InstancedLod || node instanceof Lod) lods.push(node);
    });
  const counts: LevelCount[] = [];
  for (const lod of lods) {
    const instances = lod.levels.map(() => 0);
    if (lod instanceof InstancedLod) {
      for (const chunk of lod.chunks) {
        if (chunk.instanceMatrix instanceof THREE.StorageInstancedBufferAttribute) continue;
        for (let i = 0; i < chunk.count; i++) {
          const index = chunk.getLevelAt(i, camera);
          if (index === null) continue;
          const drawing = instances[index];
          if (drawing === undefined) throw new Error(`${lod.name}: missing level ${index}`);
          instances[index] = drawing + 1;
        }
      }
    } else
      lod.levels.forEach((level, index) => {
        instances[index] = level.object?.visible ? 1 : 0;
      });
    for (const [index, level] of lod.levels.entries()) {
      const count = (counts[index] ??= { instances: 0, triangles: 0 });
      const drawing = instances[index];
      if (!drawing) continue;
      const object = level.object;
      if (!object) throw new Error(`${lod.name}: selected level ${index} is not loaded`);
      const each = triangles(object);
      if (!each) continue;
      count.instances += drawing;
      count.triangles += drawing * each;
    }
  }
  return counts;
}

function triangles(object: THREE.Object3D): number {
  let sum = 0;
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const geometry = node.geometry;
    sum += (geometry.index ? geometry.index.count : geometry.getAttribute("position").count) / 3;
  });
  return sum;
}

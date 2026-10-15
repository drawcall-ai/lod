import * as THREE from "three";
import { InstancedLod, Lod } from "@drawcall/lod";

/** Per level: instances drawing it this frame (twice-counted while fading) and their triangles. */
export interface LevelCount {
  instances: number;
  triangles: number;
}

/**
 * Counts what each level drew in its last update under `roots`: instances from each
 * InstancedLod's level counts, the visible level of each Lod; triangles as instances
 * times what one instance of the level draws.
 */
export function levelCounts(roots: THREE.Object3D[]): LevelCount[] {
  const counts: LevelCount[] = [];
  const at = (level: number) => (counts[level] ??= { instances: 0, triangles: 0 });
  for (const root of roots)
    root.traverse((node) => {
      if (node instanceof InstancedLod)
        node.levels.forEach((level, i) => {
          const count = at(i);
          // an empty level (copies too small to draw) draws nothing to count
          if (triangles(level.object) === 0) return;
          count.instances += level.count;
          count.triangles += level.count * triangles(level.object);
        });
      if (node instanceof Lod)
        node.levels.forEach((level, i) => {
          const count = at(i);
          if (!level.object.visible || triangles(level.object) === 0) return;
          count.instances += 1;
          count.triangles += triangles(level.object);
        });
    });
  return counts;
}

/** Triangles `object` draws once (an impostor is a card of two). */
function triangles(object: THREE.Object3D): number {
  let sum = 0;
  object.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = o.geometry;
    sum += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
  });
  return sum;
}

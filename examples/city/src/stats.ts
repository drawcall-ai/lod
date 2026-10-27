import * as THREE from "three/webgpu";
import { InstancedLod, Lod } from "@drawcall/lod";

/** Per level: instances drawing it this frame and their triangles. */
export interface LevelCount {
  instances: number;
  triangles: number;
}

/**
 * Counts what each level drew in its last update under `roots`: each InstancedLod's
 * instances by the finest level they drew (`levelOf`: the GPU selects, the counts are
 * worked out again here; an instance fading also draws the next coarser level, not
 * counted), the visible levels of each Lod; triangles as instances times what one
 * instance of the level draws.
 */
export function levelCounts(roots: THREE.Object3D[]): LevelCount[] {
  const counts: LevelCount[] = [];
  const at = (level: number) => (counts[level] ??= { instances: 0, triangles: 0 });
  for (const root of roots)
    root.traverse((node) => {
      if (node instanceof InstancedLod) {
        // every level listed, drawn or not
        node.levels.forEach((_, i) => at(i));
        const each = node.levels.map((level) => triangles(level.object));
        for (let i = 0; i < node.count; i++) {
          const level = node.levelOf(i);
          // an empty level (copies too small to draw) draws nothing to count
          if (level === null || !each[level]) continue;
          const count = at(level);
          count.instances++;
          count.triangles += each[level];
        }
      }
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

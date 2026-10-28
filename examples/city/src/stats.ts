import * as THREE from "three/webgpu";
import { InstancedLod, Lod } from "@drawcall/lod";

/** Per level: instances drawing it this frame and their triangles. */
export interface LevelCount {
  instances: number;
  triangles: number;
}

/**
 * Counts what each level drew in its last update: each InstancedLod's
 * instances by the finest level they drew (`levelOf`: the GPU selects, the counts are
 * worked out again here; an instance fading also draws the next coarser level, not
 * counted), the visible levels of each Lod; triangles as instances times what one
 * instance of the level draws. Triangle totals refresh when a lazy level arrives; only selection and visibility
 * need reading again for an overlay sample.
 */
export class Counts {
  private readonly entries: { lod: InstancedLod | Lod; triangles: number[] }[] = [];
  private levels = 0;
  private readonly detach: Array<() => void> = [];

  constructor(roots: readonly THREE.Object3D[]) {
    for (const root of roots)
      root.traverse((node) => {
        if (!(node instanceof InstancedLod || node instanceof Lod)) return;
        const entry = { lod: node, triangles: node.levels.map((level) => triangles(level.object)) };
        this.entries.push(entry);
        const changed = () => {
          entry.triangles = node.levels.map((level) => triangles(level.object));
        };
        node.addEventListener("levelschange", changed);
        this.detach.push(() => node.removeEventListener("levelschange", changed));
        this.levels = Math.max(this.levels, node.levels.length);
      });
  }

  dispose(): void {
    for (const remove of this.detach) remove();
  }

  read(): LevelCount[] {
    const counts = Array.from({ length: this.levels }, () => ({ instances: 0, triangles: 0 }));
    for (const { lod, triangles } of this.entries) {
      if (lod instanceof InstancedLod) {
        for (let i = 0; i < lod.count; i++) {
          const level = lod.levelOf(i);
          if (level === null) continue;
          const each = triangles[level];
          if (!each) continue;
          const count = counts[level];
          if (!count) throw new Error(`${lod.name}: no count for level ${level}`);
          count.instances++;
          count.triangles += each;
        }
        continue;
      }
      lod.levels.forEach((level, i) => {
        const each = triangles[i];
        if (!level.object.visible || !each) return;
        const count = counts[i];
        if (!count) throw new Error(`${lod.name}: no count for level ${i}`);
        count.instances++;
        count.triangles += each;
      });
    }
    return counts;
  }
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

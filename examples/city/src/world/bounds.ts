import { boundingBox, type InstancedLod, type Lod } from "@drawcall/lod";
import type { Box3 } from "three/webgpu";

export function sourceBox(lod: Lod | InstancedLod): Box3 {
  const source = lod.levels[0]?.object;
  if (!source) throw new Error(`${lod.name}: missing source level`);
  if (source.matrixAutoUpdate) source.updateMatrix();
  return boundingBox(source).applyMatrix4(source.matrix);
}

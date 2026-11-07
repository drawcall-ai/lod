import { boundingBox } from "@drawcall/lod";
import type { Box3, Object3D } from "three/webgpu";

export function sourceBox(levels: readonly { object?: Object3D; box?: Box3 }[]): Box3 {
  const source = levels[0];
  if (!source) throw new Error("Missing source level");
  if (source.box) return source.box.clone();
  const object = source.object;
  if (!object) throw new Error("Source level has no object or bounds");
  if (object.matrixAutoUpdate) object.updateMatrix();
  return boundingBox(object).applyMatrix4(object.matrix);
}

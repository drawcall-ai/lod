import { Box3, type Object3D } from "three/webgpu";

/** The box of the source level of `levels` (the first), its own transform applied: its box, else its object's. */
export function sourceBox(levels: readonly { object?: Object3D; box?: Box3 }[]): Box3 {
  const source = levels[0];
  if (!source) throw new Error("Missing source level");
  if (source.box) return source.box.clone();
  const object = source.object;
  if (!object) throw new Error("Source level has no object or bounds");
  // setFromObject measures in the world, which is the space its transform places it in only while it has no parent.
  if (object.parent) throw new Error("sourceBox: measure a source level before it joins a scene or a Lod");
  return new Box3().setFromObject(object);
}

import { Box3, type Object3D } from "three/webgpu";

/** A level as a Lod's `levels` hold it: its object once there is one, else its box. */
type Level = { object?: Object3D; box?: Box3 };

/** The box of the source level of `levels` (the first), its own transform applied. */
export function sourceBox(levels: readonly Level[]): Box3 {
  const source = levels[0];
  if (!source) throw new Error("Missing source level");
  return levelBox(source);
}

/** The box around every level of `levels`, each with its own transform applied. */
export function envelope(levels: readonly Level[]): Box3 {
  return levels.reduce((box, level) => box.union(levelBox(level)), new Box3());
}

/** A level's box, else its object's, with its own transform applied. */
export function levelBox({ object, box }: Level): Box3 {
  if (box) return box.clone();
  if (!object) throw new Error("A level has no object or bounds");
  // setFromObject measures in the world, which is the space its transform places it in only while it has no parent.
  if (object.parent) throw new Error("Measure a level before it joins a scene or a Lod");
  return new Box3().setFromObject(object);
}

/** How far from their origin `levels` reach: to the farthest corner of their envelope. */
export function reach(levels: readonly Level[]): number {
  const { min, max } = envelope(levels);
  return Math.hypot(Math.max(-min.x, max.x), Math.max(-min.y, max.y), Math.max(-min.z, max.z));
}

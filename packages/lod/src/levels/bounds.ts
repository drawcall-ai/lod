import { Box3, Sphere, Vector3, type Matrix4, type Object3D } from "three/webgpu";
import { boundingBox, local } from "../source/detail.js";
import { isMesh } from "../three.js";

// Where a Lod's levels are: the bounds each declares or draws, measured from their full detail.

const sphereOf = (box: Box3): Sphere | null => (box.isEmpty() ? null : new Sphere(box.getCenter(new Vector3()), box.getSize(new Vector3()).length() / 2));

/**
 * The sphere fades measure for a Lod's levels: level 0's, or the first level's that draws
 * anything when level 0 draws nothing; `own` in that level's own space, `placed` in its
 * parent's (the Lod's). It is the centre and half diagonal of the level's `boundingBox`,
 * which an impostor baked from it shares. `who` names the caller in the error.
 */
export function measureLevels(levels: readonly { object?: Object3D; box?: Box3 }[], who: string): { own: Sphere; placed: Sphere } {
  for (const { object, box } of levels) {
    const own = sphereOf(object ? boundingBox(object) : (box ?? new Box3()));
    if (!own) continue;
    return { own, placed: object ? own.clone().applyMatrix4(local(object)) : own.clone() };
  }
  throw new Error(`${who}: no level has visible geometry to measure`);
}

/** A level's bounds in the space of the Lod that holds it, including an eager object's transform. */
export function levelBox(level: { object?: Object3D; box?: Box3 }): Box3 {
  if (level.box) return level.box.clone();
  return level.object ? boundingBox(level.object).applyMatrix4(local(level.object)) : new Box3();
}

/** Fill absent mesh bounds conservatively from a deferred level's declared box, without reading vertices. */
export function prepareBounds(root: Object3D, box: Box3): void {
  const visit = (node: Object3D, placement: Matrix4): void => {
    if (isMesh(node)) {
      if (placement.determinant() === 0) throw new Error("Lod: mesh placement must be invertible");
      const geometry = node.geometry;
      geometry.boundingBox ??= box.clone().applyMatrix4(placement.clone().invert());
      geometry.boundingSphere ??= geometry.boundingBox.getBoundingSphere(new Sphere());
    }
    for (const child of node.children) visit(child, local(child).premultiply(placement));
  };
  visit(root, local(root));
}

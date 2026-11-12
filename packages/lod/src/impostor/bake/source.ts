import type { Object3D } from "three/webgpu";
import { bakeCopy, type BakeCopy } from "../../bake.js";
import { forEachMesh } from "../../source/detail.js";
import { isImpostorMesh } from "../../three.js";

/** A copy of `object` to bake, which the bake may move and change; ImpostorMeshes are refused. */
export function sourceForBake(object: Object3D): Promise<BakeCopy> {
  forEachMesh(object, (mesh) => {
    if (isImpostorMesh(mesh)) throw new Error(`bakeImpostor: cannot bake an ImpostorMesh ("${mesh.name}"); bake from its source instead`);
  });
  return bakeCopy(object);
}

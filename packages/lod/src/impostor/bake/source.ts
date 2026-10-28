import type { Object3D } from "three/webgpu";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { forEachMesh } from "../../bounds.js";
import { isImpostorMesh } from "../../three.js";

/** Snapshot before validation/bounds, without copying loader-added rooms or their resources. */
export function sourceForBake(object: Object3D, excluded: readonly Object3D[] = []): Object3D {
  const children = object.children;
  try {
    // SkeletonUtils has no exclusion hook. This synchronous view emits no events and
    // is restored before any await, even if validation or a custom clone throws.
    // Cloning then removing rooms would allocate excluded nested LOD resources.
    if (excluded.length > 0) object.children = children.filter((child) => !excluded.includes(child));
    forEachMesh(object, (mesh) => {
      if (isImpostorMesh(mesh)) throw new Error(`bakeImpostor: cannot bake an ImpostorMesh ("${mesh.name}"); bake from its source instead`);
    });
    return clone(object);
  } finally {
    object.children = children;
  }
}

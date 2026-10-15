import type { Mesh, Object3D } from "three";
import { originalOf } from "./fade.js";
import { isImpostorMesh, isLOD, isMesh, isTexture } from "./three.js";

/** Free what `node` and its descendants hold; a nested LOD or an ImpostorMesh frees itself. */
export function disposeTree(node: Object3D): void {
  // ImpostorMesh, InstancedMesh, a nested Lod, a GLTS scene.
  if ("dispose" in node && typeof node.dispose === "function") {
    node.dispose();
    if (isImpostorMesh(node) || isLOD(node)) return;
  }
  if (isMesh(node)) {
    node.geometry.dispose();
    disposeMaterials(node);
  }
  for (const child of node.children) disposeTree(child);
}

/** Free `mesh`'s materials, the ones they were copied from and their textures. */
export function disposeMaterials(mesh: Mesh): void {
  for (const material of [mesh.material].flat())
    for (const each of new Set([material, originalOf(material)])) {
      const values: unknown[] = Object.values(each);
      for (const value of values) if (isTexture(value)) value.dispose();
      each.dispose();
    }
}

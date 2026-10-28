import type { Mesh, Object3D } from "three/webgpu";
import { originalOf } from "./material.js";
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

/** Free `mesh`'s materials and their textures: the originals of level copies, which free their copies (see `levelMaterial`). */
function disposeMaterials(mesh: Mesh): void {
  for (const material of new Set([mesh.material].flat().map(originalOf))) {
    const values: unknown[] = Object.values(material);
    for (const value of values) if (isTexture(value)) value.dispose();
    material.dispose();
  }
}

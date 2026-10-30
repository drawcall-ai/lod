import type { Mesh, Object3D } from "three/webgpu";
import { originalOf } from "./material.js";
import { isGLTSScene, isImpostorMesh, isInstancedMesh, isLOD, isMesh, isTexture } from "./three.js";

const borrowed = new WeakSet<Mesh>();

/** Derived geometry keeps its source materials; their owner releases them. */
export function borrowMaterials(root: Object3D): void {
  root.traverse((node) => {
    if (isMesh(node)) borrowed.add(node);
  });
}

/** Clones share source geometry, materials and textures; only their own draw state is released here. */
export function disposeCopies(node: Object3D): void {
  if ((isImpostorMesh(node) || isLOD(node)) && "dispose" in node && typeof node.dispose === "function") {
    node.dispose();
    return;
  }
  if (isInstancedMesh(node)) node.dispose();
  for (const child of node.children) disposeCopies(child);
}

/** Free what `node` and its descendants hold; a nested LOD or an ImpostorMesh frees itself. */
export function disposeTree(node: Object3D): void {
  // ImpostorMesh, InstancedMesh, a nested Lod, a GLTS scene.
  if ("dispose" in node && typeof node.dispose === "function") {
    node.dispose();
    if (isImpostorMesh(node) || isLOD(node) || isGLTSScene(node)) return;
  }
  if (isMesh(node)) {
    node.geometry.dispose();
    if (!borrowed.has(node)) disposeMaterials(node);
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

/** Cleanup must not replace the failure that rejected a load or prevent the other levels from being released. */
export function disposeRejected(node: Object3D): void {
  try {
    disposeTree(node);
  } catch (error) {
    console.error("LodLoader: failed to dispose a rejected load", error);
  }
}

import type { Mesh, Object3D } from "three/webgpu";
import { originalOf } from "./levels/material.js";
import { isGLTSScene, isImpostorMesh, isInstancedMesh, isLOD, isMesh, isTexture } from "./three.js";

// Freeing what a tree of objects holds: whoever made a tree frees it, and only what it made.

/** Clones share source geometry, materials and textures; only their own draw state is released here. */
export function disposeCopies(node: Object3D): void {
  if (isImpostorMesh(node) || isLOD(node)) {
    node.dispose();
    return;
  }
  // An InstancedMesh's clone has instance buffers of its own. Any other node fires what Object3D.dispose fires, which frees
  // its draw state: a subclass's own dispose may free what the clone shares.
  if (isInstancedMesh(node)) node.dispose();
  else node.dispatchEvent({ type: "dispose" });
  for (const child of node.children) disposeCopies(child);
}

/** What `disposeTree` frees beside geometry and draw state. */
export interface DisposeOptions {
  /** whether the tree's materials and their textures are its own; false for a tree drawn with its source's, as a simplified level is */
  materials: boolean;
}

/** Free what `node` and its descendants hold; a nested LOD or an ImpostorMesh frees itself. */
export function disposeTree(node: Object3D, { materials }: DisposeOptions = { materials: true }): void {
  // Every object frees its draw state; an ImpostorMesh, a nested Lod and a GLTS scene free the rest too.
  node.dispose();
  if (isImpostorMesh(node) || isLOD(node) || isGLTSScene(node)) return;
  if (isMesh(node)) {
    node.geometry.dispose();
    if (materials) disposeMaterials(node);
  }
  for (const child of node.children) disposeTree(child, { materials });
}

/**
 * Free `mesh`'s materials and their textures: the originals of level copies, which free their copies (see
 * `levelMaterial`). Images stay open: another object, or three's Cache, may share them and upload them again.
 */
function disposeMaterials(mesh: Mesh): void {
  for (const material of new Set([mesh.material].flat().map(originalOf))) {
    const values: unknown[] = Object.values(material);
    for (const value of values) if (isTexture(value)) value.dispose();
    material.dispose();
  }
}

/** Cleanup must not replace the failure that rejected a load or prevent the other levels from being released. */
export function disposeRejected(node: Object3D, options?: DisposeOptions): void {
  try {
    disposeTree(node, options);
  } catch (error) {
    console.error("LodLoader: failed to dispose a rejected load", error);
  }
}

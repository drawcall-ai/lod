import type { BufferGeometry, Object3D } from "three/webgpu";
import { isImpostorMesh, isInstancedMesh, isLazyImpostor, isMesh } from "../three.js";

/** Failed simplifications own new geometry, but borrow source materials and untouched geometry. */
export function disposeSimplified(copy: Object3D, source: Object3D): void {
  const kept = new Set<BufferGeometry>();
  source.traverse((node) => {
    if (isMesh(node)) kept.add(node.geometry);
  });
  copy.traverse((node) => {
    // These clones retain their own references; their disposal releases only those.
    if (isImpostorMesh(node) || isLazyImpostor(node)) {
      node.dispose();
      return;
    }
    if (!isMesh(node)) return;
    if (!kept.has(node.geometry)) {
      node.geometry.dispose();
      kept.add(node.geometry);
    }
    if (isInstancedMesh(node)) node.dispose();
  });
}

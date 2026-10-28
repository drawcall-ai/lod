import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Batch compatible static pieces in the variant's space, keeping original geometry shared. */
export function propMeshes(root: THREE.Object3D): THREE.Object3D {
  const materials = new Map<THREE.Material, THREE.Mesh[][]>();
  root.updateMatrixWorld(true);
  const outside = root.matrixWorld.clone().invert();
  root.traverseVisible((mesh) => {
    if (
      !(mesh instanceof THREE.Mesh) ||
      mesh instanceof THREE.SkinnedMesh ||
      mesh instanceof THREE.InstancedMesh ||
      Array.isArray(mesh.material) ||
      mesh.material.transparent ||
      mesh.children.length
    )
      return;
    const geometry = mesh.geometry;
    const count = geometry.index?.count ?? geometry.getAttribute("position").count;
    if (geometry.drawRange.start !== 0 || geometry.drawRange.count < count || Object.keys(geometry.morphAttributes).length) return;
    let groups = materials.get(mesh.material);
    if (!groups) materials.set(mesh.material, (groups = []));
    const group = groups.find((group) => group[0] && compatible(group[0], mesh));
    if (group) group.push(mesh);
    else groups.push([mesh]);
  });
  for (const groups of materials.values()) {
    for (const group of groups) {
      const first = group[0];
      if (!first || group.length < 2) continue;
      const pieces = group.map((mesh) => mesh.geometry.clone().applyMatrix4(outside.clone().multiply(mesh.matrixWorld)));
      const geometry = mergeGeometries(pieces, true);
      for (const piece of pieces) piece.dispose();
      if (!geometry) throw new Error(`Compatible prop geometries failed to merge: ${first.name}`);
      // Keep each piece's simplification budget while drawing the single material once.
      for (const part of geometry.groups) part.materialIndex = 0;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const merged = first.clone(false);
      merged.geometry = geometry;
      merged.position.set(0, 0, 0);
      merged.quaternion.identity();
      merged.scale.set(1, 1, 1);
      merged.matrix.identity();
      for (const mesh of group) mesh.removeFromParent();
      root.add(merged);
    }
  }
  return root;
}

function compatible(left: THREE.Mesh, right: THREE.Mesh): boolean {
  if (
    left.castShadow !== right.castShadow ||
    left.receiveShadow !== right.receiveShadow ||
    left.layers.mask !== right.layers.mask ||
    left.renderOrder !== right.renderOrder ||
    left.frustumCulled !== right.frustumCulled
  )
    return false;
  const a = left.geometry,
    b = right.geometry;
  if ((a.index === null) !== (b.index === null)) return false;
  const names = Object.keys(a.attributes);
  if (names.length !== Object.keys(b.attributes).length) return false;
  return names.every((name) => {
    const first = a.getAttribute(name),
      second = b.getAttribute(name);
    return (
      second !== undefined &&
      first.array.constructor === second.array.constructor &&
      first.itemSize === second.itemSize &&
      first.normalized === second.normalized &&
      ("gpuType" in first ? first.gpuType : undefined) === ("gpuType" in second ? second.gpuType : undefined)
    );
  });
}

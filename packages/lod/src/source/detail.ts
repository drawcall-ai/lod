import { Box3, Matrix4, Vector3, type Mesh, type Object3D } from "three/webgpu";
import type { Lod } from "../lod.js";
import { isBatchedMesh, isImpostorMesh, isInstancedMesh, isLOD, isLod, isMesh, isStorageInstanced } from "../three.js";

// What an object is at full detail: its meshes, where they sit and the vertices they draw.

/**
 * Call `visit` with every mesh of `root` drawn at full detail, and the matrix that places
 * it in `root`'s own space (`root`'s own transform not applied): `root` itself and its
 * visible descendants; of a nested LOD only its level 0, whatever it shows; and once per
 * instance, the meshes of an InstancedMesh or ImpostorMesh and of a Lod's level 0. `placement` is only valid during the call. Local matrices are
 * brought up to date on the way.
 */
export function forEachMesh(root: Object3D, visit: (mesh: Mesh, placement: Matrix4) => void): void {
  walk(root, new Matrix4(), visit);
}

/** `forEachMesh` from `node`, which `placement` places in the root's space. */
function walk(node: Object3D, placement: Matrix4, visit: (mesh: Mesh, placement: Matrix4) => void): void {
  if (isLod(node)) {
    // Its level 0 is a template, not in the scene: it stands once per instance.
    const source = node.levels[0]?.object;
    if (!source) return;
    const instance = new Matrix4();
    for (const index of instancesOf(node)) walk(source, local(source).premultiply(node.getMatrixAt(index, instance)).premultiply(placement), visit);
    return;
  }
  if (isInstancedMesh(node) || isImpostorMesh(node)) {
    const instance = new Matrix4();
    for (let i = 0; i < node.count; i++) visit(node, node.getMatrixAt(i, instance).premultiply(placement));
  } else if (isMesh(node)) visit(node, placement);
  for (const child of detailed(node)) walk(child, local(child).premultiply(placement), visit);
}

/** The children of `node` drawn at full detail: of a LOD its level 0, whatever it shows, else the visible ones. */
export function detailed(node: Object3D): Object3D[] {
  if (!isLOD(node)) return node.children.filter((child) => child.visible);
  const source = node.levels[0]?.object;
  return source ? [source] : [];
}

/** `node`'s matrix in its parent's space, up to date. */
export function local(node: Object3D): Matrix4 {
  if (node.matrixAutoUpdate) node.updateMatrix();
  return node.matrix.clone();
}

/** Show level 0 of every LOD under `root` and stop them switching: a bake sees full detail. */
export function showDetail(root: Object3D): void {
  if (isLod(root)) throw new Error("@drawcall/lod: a bake draws a Lod as InstancedMeshes of its level 0 (see bakeCopy)");
  if (isLOD(root)) {
    root.autoUpdate = false;
    root.levels.forEach((level, i) => {
      if (level.object) level.object.visible = i === 0;
    });
  }
  for (const child of detailed(root)) showDetail(child);
}

/**
 * Call `visit` with every vertex drawn at full detail (see `forEachMesh`), in `root`'s own
 * space: of meshes with a drawn material, skinned and morphed as rendered; the bounds of
 * an ImpostorMesh. `visit` gets one reused vector.
 */
export function forEachVertex(root: Object3D, visit: (p: Vector3) => void): void {
  const point = new Vector3();
  const corners = (box: Box3 | null, placement: Matrix4) => {
    if (!box || box.isEmpty()) return;
    const { min, max } = box;
    for (let i = 0; i < 8; i++) visit(point.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).applyMatrix4(placement));
  };
  forEachMesh(root, (mesh, placement) => {
    const drawn = [mesh.material].flat().some((m) => m.visible && m.colorWrite);
    if (!drawn) return;
    if (isBatchedMesh(mesh)) {
      // Its instance list is private; the corners of its instances' union box are close enough.
      mesh.computeBoundingBox();
      return corners(mesh.boundingBox, placement);
    }
    // Its geometry is a card built in the shader; its box is the baked object's.
    if (isImpostorMesh(mesh)) return corners(mesh.geometry.boundingBox, placement);
    const position = mesh.geometry.getAttribute("position");
    if (!position) return;
    // getVertexPosition applies morphs and, on a SkinnedMesh, the bones.
    for (let i = 0; i < position.count; i++) visit(mesh.getVertexPosition(i, point).applyMatrix4(placement));
  });
}

/** Conservative full-detail bounds from cached geometry boxes and deferred metadata, in the root's space: what a bake measures. */
export function boundingBox(root: Object3D): Box3 {
  const box = new Box3();
  boxes(root, new Matrix4(), box);
  return box;
}

function boxes(node: Object3D, placement: Matrix4, box: Box3): void {
  if (isLod(node)) {
    const source = node.levels[0];
    if (!source) return;
    // Its level 0 at every instance, as forEachMesh visits them: tighter than its level meshes' box (see Lod).
    // The box it declares, else the one it draws.
    const own = source.box?.clone() ?? (source.object ? boundingBox(source.object).applyMatrix4(local(source.object)) : new Box3());
    const instance = new Matrix4();
    for (const index of instancesOf(node)) box.union(own.clone().applyMatrix4(node.getMatrixAt(index, instance).premultiply(placement)));
    return;
  }
  if (isLOD(node) && !node.levels[0]?.object) {
    const metadata = node.levels[0]?.box;
    if (metadata) box.union(metadata.clone().applyMatrix4(placement));
    return;
  }
  if (isMesh(node) && [node.material].flat().some((material) => material.visible && material.colorWrite)) {
    if (isBatchedMesh(node)) {
      if (!node.boundingBox) node.computeBoundingBox();
      if (node.boundingBox) box.union(node.boundingBox.clone().applyMatrix4(placement));
    } else {
      if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
      const own = node.geometry.boundingBox;
      if (own && (isInstancedMesh(node) || isImpostorMesh(node))) {
        const instance = new Matrix4();
        for (let i = 0; i < node.count; i++) box.union(own.clone().applyMatrix4(node.getMatrixAt(i, instance).premultiply(placement)));
      } else if (own) box.union(own.clone().applyMatrix4(placement));
    }
  }
  for (const child of detailed(node)) boxes(child, local(child).premultiply(placement), box);
}

/**
 * The indices of the instances `lod` draws: of its first `count`, those in its clusters, if it has any. A storage
 * instanceMatrix's live on the GPU, where the CPU cannot visit them.
 */
export function* instancesOf(lod: Lod): Generator<number> {
  if (isStorageInstanced(lod.instanceMatrix)) throw new Error("@drawcall/lod: a Lod's storage instanceMatrix lives on the GPU: the CPU cannot visit its meshes");
  for (const { start, count } of lod.clusters ?? [{ start: 0, count: lod.count }])
    for (let index = start; index < Math.min(start + count, lod.count); index++) yield index;
}

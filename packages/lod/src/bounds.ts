import { Box3, Matrix4, Sphere, Vector3, type Mesh, type Object3D } from "three/webgpu";
import { isBatchedMesh, isImpostorMesh, isInstancedLod, isInstancedMesh, isLOD, isMesh } from "./three.js";

// What an object is at full detail: its meshes, where they sit and the vertices they draw.

/**
 * Call `visit` with every mesh of `root` drawn at full detail, and the matrix that places
 * it in `root`'s own space (`root`'s own transform not applied): `root` itself and its
 * visible descendants; of a nested LOD only its level 0, whatever it shows; and once per
 * instance, the meshes of an InstancedMesh or ImpostorMesh and of an InstancedLod's
 * level 0. `placement` is only valid during the call. Local matrices are
 * brought up to date on the way.
 */
export function forEachMesh(root: Object3D, visit: (mesh: Mesh, placement: Matrix4) => void): void {
  walk(root, new Matrix4(), visit);
}

/** `forEachMesh` from `node`, which `placement` places in the root's space. */
function walk(node: Object3D, placement: Matrix4, visit: (mesh: Mesh, placement: Matrix4) => void): void {
  if (isInstancedLod(node)) {
    // Its level 0 is a template, not in the scene: it stands once per instance.
    const source = node.levels[0]?.object;
    if (!source) return;
    const instance = new Matrix4();
    for (let i = 0; i < node.count; i++) walk(source, local(source).premultiply(node.getMatrixAt(i, instance)).premultiply(placement), visit);
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
  const source = node.levels[0];
  return source ? [source.object] : [];
}

/** `node`'s matrix in its parent's space, up to date. */
function local(node: Object3D): Matrix4 {
  if (node.matrixAutoUpdate) node.updateMatrix();
  return node.matrix.clone();
}

/** Show level 0 of every LOD under `root` and stop them switching: a bake sees full detail. */
export function showDetail(root: Object3D): void {
  if (isInstancedLod(root)) {
    root.forceLevel = 0;
    return;
  }
  if (isLOD(root)) {
    root.autoUpdate = false;
    root.levels.forEach((level, i) => (level.object.visible = i === 0));
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

/** Bounds of every vertex that draws at full detail, in `root`'s own space. */
export function boundingBox(root: Object3D): Box3 {
  const box = new Box3();
  forEachVertex(root, (p) => box.expandByPoint(p));
  return box;
}

/** The centre and half diagonal of `boundingBox(root)`: an impostor baked from `root` has the same box. */
export function boundingSphere(root: Object3D): Sphere {
  const sphere = sphereOf(boundingBox(root));
  if (!sphere) throw new Error("@drawcall/lod: object has no visible geometry to measure");
  return sphere;
}

const sphereOf = (box: Box3): Sphere | null => (box.isEmpty() ? null : new Sphere(box.getCenter(new Vector3()), box.getSize(new Vector3()).length() / 2));

/**
 * The sphere fades measure for a Lod's levels (see `boundingSphere`): level 0's, or the
 * first level's that draws anything when level 0 draws nothing; `own` in that level's
 * own space, `placed` in its parent's (the Lod's). `who` names the caller in the error.
 */
export function measureLevels(levels: readonly Object3D[], who: string): { own: Sphere; placed: Sphere } {
  for (const level of levels) {
    const own = sphereOf(boundingBox(level));
    if (!own) continue;
    if (level.matrixAutoUpdate) level.updateMatrix();
    return { own, placed: own.clone().applyMatrix4(level.matrix) };
  }
  throw new Error(`${who}: no level has visible geometry to measure`);
}

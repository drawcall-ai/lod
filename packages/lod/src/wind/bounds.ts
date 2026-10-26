import { Matrix4, Sphere, Vector3, type InstancedMesh, type Mesh } from "three";
import { isImpostorMesh, isInstancedMesh } from "../three.js";
import { impostorCasterRadius } from "../impostor/mesh/index.js";

/** Bound maximum sway on the mesh itself, leaving shared geometry in its rest pose. */
export function windBounds(mesh: Mesh, placement: Matrix4, amplitude: number, baseY: number, height: number): void {
  const { geometry } = mesh;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || box.isEmpty()) return;
  if (placement.determinant() === 0) throw new Error("Wind: a mesh's placement must be invertible");

  const rest = box.getBoundingSphere(new Sphere());
  const root = box.clone().applyMatrix4(placement);
  const reach = Math.max(Math.abs(root.min.y - baseY), Math.abs(root.max.y - baseY)) / height;
  rest.radius += amplitude * reach * horizontalScale(placement.clone().invert());
  if (isImpostorMesh(mesh)) impostorCasterRadius(mesh, rest.radius);
  if (!isInstancedMesh(mesh)) {
    // Frustum.intersectsObject prefers an object's sphere over its geometry's.
    Object.assign(mesh, { boundingSphere: rest });
    return;
  }

  // As for InstancedMesh normally, callers recompute after changing instance transforms.
  // Start from the geometry's rest box every time wind is attached, including on clones.
  mesh.computeBoundingSphere = function (this: InstancedMesh): void {
    this.boundingSphere ??= new Sphere();
    this.boundingSphere.makeEmpty();
    const matrix = new Matrix4();
    const sphere = new Sphere();
    for (let i = 0; i < this.count; i++) {
      this.getMatrixAt(i, matrix);
      this.boundingSphere.union(sphere.copy(rest).applyMatrix4(matrix));
    }
  };
  mesh.computeBoundingSphere();
}

/** Largest stretch of a horizontal unit vector, including sheared placements. */
function horizontalScale(matrix: Matrix4): number {
  const x = new Vector3().setFromMatrixColumn(matrix, 0);
  const z = new Vector3().setFromMatrixColumn(matrix, 2);
  const xx = x.lengthSq();
  const zz = z.lengthSq();
  return Math.sqrt((xx + zz + Math.hypot(xx - zz, 2 * x.dot(z))) / 2);
}

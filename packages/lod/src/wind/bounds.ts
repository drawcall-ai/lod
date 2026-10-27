import { Matrix4, Sphere, Vector3, type Mesh } from "three/webgpu";
import { drawOf } from "../fade.js";
import { isImpostorMesh, isInstancedMesh } from "../three.js";

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
  // An ImpostorMesh of its own measures its shadow casters by this radius too.
  const draw = drawOf(mesh);
  if (draw?.kind === "instances") draw.radius = rest.radius;
  const instances = isInstancedMesh(mesh) || isImpostorMesh(mesh) ? mesh : null;
  if (!instances) {
    // Frustum.intersectsObject prefers an object's sphere over its geometry's.
    Object.assign(mesh, { boundingSphere: rest });
    return;
  }

  // As for InstancedMesh normally, callers recompute after changing instance transforms.
  // Start from the geometry's rest box every time wind is attached, including on clones.
  instances.computeBoundingSphere = () => {
    const bounds = (instances.boundingSphere ??= new Sphere()).makeEmpty();
    const matrix = new Matrix4();
    const sphere = new Sphere();
    for (let i = 0; i < instances.count; i++) bounds.union(sphere.copy(rest).applyMatrix4(instances.getMatrixAt(i, matrix)));
  };
  instances.computeBoundingSphere();
}

/** Largest stretch of a horizontal unit vector, including sheared placements. */
function horizontalScale(matrix: Matrix4): number {
  const x = new Vector3().setFromMatrixColumn(matrix, 0);
  const z = new Vector3().setFromMatrixColumn(matrix, 2);
  const xx = x.lengthSq();
  const zz = z.lengthSq();
  return Math.sqrt((xx + zz + Math.hypot(xx - zz, 2 * x.dot(z))) / 2);
}

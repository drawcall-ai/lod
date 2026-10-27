import type { Vector3 } from "three/webgpu";

/**
 * The tangent frame three derives for a normal map when a mesh has no tangents
 * (getTangentFrame in normalmap_pars_fragment), from a triangle instead of screen
 * derivatives: `e1`, `e2` its edges from the first corner, (`du1`, `dv1`) and
 * (`du2`, `dv2`) their UV deltas, `n` the unit normal there. Writes `t` and `b` scaled as
 * three scales them; the frame is (t, b, n), not orthonormal. For a triangle three sees
 * from the front, the result is three's exactly: both are the UV gradients along the
 * surface, up to the same positive factor, which the scaling cancels.
 */
export function tangentFrame(e1: Vector3, e2: Vector3, du1: number, dv1: number, du2: number, dv2: number, n: Vector3, t: Vector3, b: Vector3): void {
  // q1perp = e2 × n, q0perp = n × e1
  const px = e2.y * n.z - e2.z * n.y;
  const py = e2.z * n.x - e2.x * n.z;
  const pz = e2.x * n.y - e2.y * n.x;
  const qx = n.y * e1.z - n.z * e1.y;
  const qy = n.z * e1.x - n.x * e1.z;
  const qz = n.x * e1.y - n.y * e1.x;
  t.set(px * du1 + qx * du2, py * du1 + qy * du2, pz * du1 + qz * du2);
  b.set(px * dv1 + qx * dv2, py * dv1 + qy * dv2, pz * dv1 + qz * dv2);
  const det = Math.max(t.lengthSq(), b.lengthSq());
  const scale = det === 0 ? 0 : 1 / Math.sqrt(det);
  t.multiplyScalar(scale);
  b.multiplyScalar(scale);
}

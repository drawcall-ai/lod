import type { Node } from "three/webgpu";
import { abs, cross, float, max, normalize, select, step, vec2, vec3 } from "three/tsl";
import type { ImpostorLayout } from "./impostor.js";

export type Vec3 = [number, number, number];

// The octahedral maps. Frame (col, row) of an N x N atlas sits at grid point
// (col, row) / (N - 1), so the outer frames lie exactly on the edge of the map:
// the horizon for "hemi", the nadir seam for "full". The bake and the shader both
// derive every direction from the same map; the node versions below mirror it.

/** Grid position in [0, 1]^2 to a unit direction. */
function octDecode(layout: ImpostorLayout, u: number, v: number): Vec3 {
  let [x, z] = layout === "hemi" ? [u - v, u + v - 1] : [u * 2 - 1, v * 2 - 1];
  const y = 1 - Math.abs(x) - Math.abs(z);
  if (layout === "full" && y < 0) [x, z] = fold(x, z);
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

/** The lower half of the full octahedron, folded over the upper one's diagonal edges. */
function fold(x: number, z: number): [number, number] {
  return [(1 - Math.abs(z)) * signOf(x), (1 - Math.abs(x)) * signOf(z)];
}

function signOf(v: number): number {
  return v >= 0 ? 1 : -1;
}

/** The direction frame (col, row) was baked from. */
export function frameDirection(layout: ImpostorLayout, frames: number, col: number, row: number): Vec3 {
  return octDecode(layout, col / (frames - 1), row / (frames - 1));
}

/**
 * The image-plane axes of a view looking back along `n` (camera at +n): tangent is
 * screen right, bitangent screen up. Up-aligned except straight above or below.
 */
export function frameBasis(n: Vec3): { tangent: Vec3; bitangent: Vec3 } {
  // Near the poles: x with n projected out, so the basis stays orthonormal. Else cross((0, 1, 0), n).
  const t: Vec3 = Math.abs(n[1]) > 0.999 ? [1 - n[0] * n[0], -n[0] * n[1], -n[0] * n[2]] : [n[2], 0, -n[0]];
  const length = Math.hypot(...t);
  const tangent: Vec3 = [t[0] / length, t[1] / length, t[2] / length];
  const bitangent: Vec3 = [n[1] * tangent[2] - n[2] * tangent[1], n[2] * tangent[0] - n[0] * tangent[2], n[0] * tangent[1] - n[1] * tangent[0]];
  return { tangent, bitangent };
}

/** A node's sign as the maps use it: 1 at zero. */
const signOfNode = (v: Node<"vec2">) => step(vec2(0, 0), v).mul(2).sub(1);

/** `octDecode` in the shaders, for `layout`: grid position to unit direction. */
export function decodeNode(layout: ImpostorLayout, uv: Node<"vec2">): Node<"vec3"> {
  if (layout === "hemi") {
    const x = uv.x.sub(uv.y);
    const z = uv.x.add(uv.y).sub(1);
    return normalize(vec3(x, float(1).sub(abs(x)).sub(abs(z)), z));
  }
  const xz = uv.mul(2).sub(1);
  const y = float(1).sub(abs(xz.x)).sub(abs(xz.y));
  const folded = select(y.lessThan(0), vec2(1).sub(abs(xz.yx)).mul(signOfNode(xz)), xz);
  return normalize(vec3(folded.x, y, folded.y));
}

/** Unit direction to grid position; hemi clamps directions below the horizon. */
export function encodeNode(layout: ImpostorLayout, d: Node<"vec3">): Node<"vec2"> {
  if (layout === "hemi") {
    const up = vec3(d.x, max(d.y, 0), d.z);
    const n = up.div(max(abs(up.x).add(abs(up.y)).add(abs(up.z)), 1e-6));
    return vec2(n.x.add(n.z).add(1), n.z.sub(n.x).add(1)).mul(0.5);
  }
  const n = d.div(abs(d.x).add(abs(d.y)).add(abs(d.z)));
  const folded = select(n.y.lessThan(0), vec2(1).sub(abs(n.zx)).mul(signOfNode(n.xz)), n.xz);
  return folded.mul(0.5).add(0.5);
}

/** `frameBasis` in the shaders: the image-plane axes of a view looking back along `n`. */
export function basisNode(n: Node<"vec3">): { tangent: Node<"vec3">; bitangent: Node<"vec3"> } {
  const tangent = select(abs(n.y).greaterThan(0.999), normalize(vec3(1, 0, 0).sub(n.mul(n.x))), normalize(vec3(n.z, 0, n.x.negate())));
  return { tangent, bitangent: cross(n, tangent) };
}

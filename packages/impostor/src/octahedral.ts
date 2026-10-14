import type { ImpostorLayout } from "./impostor.js";

export type Vec3 = [number, number, number];

// The octahedral maps. Frame (col, row) of an N x N atlas sits at grid point
// (col, row) / (N - 1), so the outer frames lie exactly on the edge of the map:
// the horizon for "hemi", the nadir seam for "full". The bake and the shader both
// derive every direction from these two functions; GLSL below mirrors them.

/** Grid position in [0, 1]^2 to a unit direction. */
export function octDecode(layout: ImpostorLayout, u: number, v: number): Vec3 {
  let [x, z] = layout === "hemi" ? [u - v, u + v - 1] : [u * 2 - 1, v * 2 - 1];
  const y = 1 - Math.abs(x) - Math.abs(z);
  if (layout === "full" && y < 0) [x, z] = fold(x, z);
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

/**
 * Unit direction to grid position in [0, 1]^2. "hemi" clamps directions below the
 * horizon onto it (straight down has no horizon point and maps to the zenith).
 */
export function octEncode(layout: ImpostorLayout, d: Vec3): [number, number] {
  const [dx, dy, dz] = d;
  const y = layout === "hemi" ? Math.max(dy, 0) : dy;
  const sum = Math.abs(dx) + Math.abs(y) + Math.abs(dz) || 1;
  let [x, z] = [dx / sum, dz / sum];
  if (layout === "hemi") return [(1 + x + z) / 2, (1 + z - x) / 2];
  if (y < 0) [x, z] = fold(x, z);
  return [(x + 1) / 2, (z + 1) / 2];
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
  const bitangent: Vec3 = [
    n[1] * tangent[2] - n[2] * tangent[1],
    n[2] * tangent[0] - n[0] * tangent[2],
    n[0] * tangent[1] - n[1] * tangent[0],
  ];
  return { tangent, bitangent };
}

/** The same maths for the shaders. `IMPOSTOR_FULL` selects the full layout. */
export const OCTAHEDRAL_GLSL = /* glsl */ `
vec2 impostorSignOf(vec2 v) { return vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0); }

vec3 impostorDecode(vec2 uv) {
  #ifdef IMPOSTOR_FULL
    vec3 d = vec3(uv.x * 2.0 - 1.0, 0.0, uv.y * 2.0 - 1.0);
    d.y = 1.0 - abs(d.x) - abs(d.z);
    if (d.y < 0.0) d.xz = (1.0 - abs(d.zx)) * impostorSignOf(d.xz);
  #else
    vec3 d = vec3(uv.x - uv.y, 0.0, uv.x + uv.y - 1.0);
    d.y = 1.0 - abs(d.x) - abs(d.z);
  #endif
  return normalize(d);
}

vec2 impostorEncode(vec3 d) {
  #ifdef IMPOSTOR_FULL
    d /= abs(d.x) + abs(d.y) + abs(d.z);
    if (d.y < 0.0) d.xz = (1.0 - abs(d.zx)) * impostorSignOf(d.xz);
    return d.xz * 0.5 + 0.5;
  #else
    d.y = max(d.y, 0.0);
    d /= max(abs(d.x) + abs(d.y) + abs(d.z), 1e-6);
    return vec2(1.0 + d.x + d.z, 1.0 + d.z - d.x) * 0.5;
  #endif
}

void impostorBasis(vec3 n, out vec3 tangent, out vec3 bitangent) {
  tangent = abs(n.y) > 0.999 ? normalize(vec3(1.0, 0.0, 0.0) - n * n.x) : normalize(vec3(n.z, 0.0, -n.x));
  bitangent = cross(n, tangent);
}
`;

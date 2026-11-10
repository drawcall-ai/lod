import { type Object3D, type Vector3 } from "three/webgpu";
import { forEachVertex } from "../../source/detail.js";
import { frameBasis, type Vec3 } from "../octahedral.js";

/**
 * The smallest square half-size that holds the object in every frame: the largest
 * extent of any vertex along any frame's image axes. Tighter than the bounding
 * sphere, which wastes about a third of every frame on a tree.
 */
export function fittedHalfSize(source: Object3D, centre: Vector3, directions: Vec3[]): number {
  const axes = directions.flatMap((n) => {
    const { tangent, bitangent } = frameBasis(n);
    return [tangent, bitangent];
  });
  // Cauchy–Schwarz bounds every projection by radius × axis length, with a little slack for rounding.
  const norm2 = axes.reduce((max, [x, y, z]) => Math.max(max, x * x + y * y + z * z), 0) * (1 + 1e-9);
  let half = 0;
  forEachVertex(source, (p) => {
    p.sub(centre);
    if (p.lengthSq() * norm2 < half * half) return;
    for (const a of axes) half = Math.max(half, Math.abs(p.x * a[0] + p.y * a[1] + p.z * a[2]));
  });
  if (half === 0) throw new Error("bakeImpostor: object has no extent (every vertex is at one point)");
  return half;
}

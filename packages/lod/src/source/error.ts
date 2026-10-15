import { BufferAttribute, BufferGeometry, Vector3 } from "three";
import { MeshBVH } from "three-mesh-bvh";
import { Shading } from "./shading.js";
import type { Source } from "./source.js";
import { triangleArea, type Surface } from "./surface.js";
import { Tracer } from "./trace.js";

/** Points sampled per surface to measure the error. */
const SAMPLES = 20000;

/**
 * How far a level's surface `low` is from `source`'s: the distances from points spread
 * evenly by area over each surface to the other, measured with a BVH. Source points
 * nobody sees from outside (a floor inside, the inner side of a partition) are left out:
 * they need no counterpart on the level. `error` is the 99.9th percentile of the
 * distances, `widest` the largest. A high percentile, as what a level moves (a part
 * collapsed or cut off) is often a sliver of the area.
 */
export function measureError(source: Source, low: Surface): { error: number; widest: number } {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(low.positions, 3));
  // The BVH reorders the index it is built on.
  geometry.setIndex(new BufferAttribute(low.index.slice(), 1));
  const toLow = new MeshBVH(geometry);
  const distances: number[] = [];
  measure(low, (point) => distances.push(closest(source.bvh, point)));
  const visible = visibility(source);
  measure(source, (point, triangle) => {
    if (visible(point, triangle)) distances.push(closest(toLow, point));
  });
  const sorted = Float64Array.from(distances).sort();
  return { error: sorted[Math.floor(0.999 * (sorted.length - 1))] ?? 0, widest: sorted[sorted.length - 1] ?? 0 };
}

const hit = { point: new Vector3(), distance: 0, faceIndex: 0 };

function closest(bvh: MeshBVH, point: Vector3): number {
  if (!bvh.closestPointToPoint(point, hit)) throw new Error("@drawcall/lod: no closest point to measure the error by");
  return hit.distance;
}

/**
 * Whether a point of a source triangle is seen from outside: a ray from it along the
 * triangle's normal (either way, for a double-sided material) leaves the source's
 * bounds without meeting an opaque surface, from either side.
 */
function visibility(source: Source): (point: Vector3, triangle: number) => boolean {
  const geometry = source.bvh.geometry;
  geometry.computeBoundingSphere();
  const bounds = geometry.boundingSphere;
  if (!bounds) throw new Error("@drawcall/lod: the source has no bounds");
  const shading = new Shading(source, 0);
  const tracer = new Tracer(source, shading);
  const normal = new Vector3();
  const corner = new Vector3();
  const origin = new Vector3();
  const epsilon = bounds.radius * 1e-4;
  const far = bounds.radius * 4;
  const escapes = (point: Vector3, direction: Vector3) =>
    tracer.cast(origin.copy(point).addScaledVector(direction, epsilon), direction, far, null) !== "opaque";
  return (point, triangle) => {
    const { positions, index } = source;
    const a = (index[triangle * 3] ?? 0) * 3;
    normal.fromArray(positions, (index[triangle * 3 + 1] ?? 0) * 3).sub(corner.fromArray(positions, a));
    corner.fromArray(positions, (index[triangle * 3 + 2] ?? 0) * 3).sub(origin.fromArray(positions, a));
    normal.cross(corner).normalize();
    if (escapes(point, normal)) return true;
    return shading.material(triangle).doubleSided && escapes(point, normal.negate());
  };
}

/** Call `visit` with points spread evenly by area over `from`, and the triangle of each. */
function measure(from: Surface, visit: (point: Vector3, triangle: number) => void): void {
  const { positions, index } = from;
  const count = index.length / 3;
  const cumulative = new Float64Array(count);
  let total = 0;
  for (let t = 0; t < count; t++) cumulative[t] = total += triangleArea(positions, 3, index, t * 3);
  const point = new Vector3();
  const corner = new Vector3();
  let t = 0;
  for (let i = 0; i < SAMPLES; i++) {
    // Stratified by area; within a triangle, a low-discrepancy (R2) point.
    const target = ((i + 0.5) / SAMPLES) * total;
    while (t < count - 1 && (cumulative[t] ?? 0) < target) t++;
    let r1 = (i * 0.7548776662466927) % 1;
    let r2 = (i * 0.5698402909980532) % 1;
    if (r1 + r2 > 1) [r1, r2] = [1 - r1, 1 - r2];
    point.fromArray(positions, (index[t * 3] ?? 0) * 3).multiplyScalar(1 - r1 - r2);
    point.addScaledVector(corner.fromArray(positions, (index[t * 3 + 1] ?? 0) * 3), r1);
    point.addScaledVector(corner.fromArray(positions, (index[t * 3 + 2] ?? 0) * 3), r2);
    visit(point, t);
  }
}

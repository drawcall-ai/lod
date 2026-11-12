import { Box3, Sphere, Vector3, type Frustum } from "three/webgpu";
import { at } from "../at.js";
import { isBox3 } from "../three.js";
import type { LocalCamera } from "./camera.js";
import type { Cull } from "./cull.js";
import type { Measured } from "./instances.js";
import { MAX_SURVIVOR_SCALE } from "./measure.js";
import type { InstanceShape } from "./shape.js";

// Which of a Lod's instances a camera sees, cluster by cluster, and the heights they can have on its screen: what
// loads, which level meshes draw, and which instances the GPU sorts. Without clusters, the first `count` instances are
// one cluster bounded by `boundingBox`, else by what the CPU measures of a CPU instanceMatrix.

/**
 * A range of a Lod's instances, `count` from `start`, which draw inside `boundingBox` in the Lod's space, with the
 * smallest scale of their matrices' longest axes and the largest stretch of any direction when known.
 */
export interface LodCluster {
  start: number;
  count: number;
  boundingBox: Box3;
  minScale?: number;
  maxScale?: number;
}

/** A cluster as the CPU tests it: its range clipped to `count`, its box grown for survivors (none if unbounded), its scales. */
interface Area {
  start: number;
  size: number;
  box: Box3 | null;
  low: number;
  high: number;
}

const area: Area = { start: 0, size: 0, box: null, low: 0, high: 0 };
const grownBox = new Box3();
const measuredScratch = new Box3();
const size3 = new Vector3();

/**
 * Call `visit` with each cluster of `lod` that holds instances, in one reused Area: its box grown by how far survivors
 * of a cullDistance grow past it, by up to `grow`, about their origins.
 */
function forEachArea(lod: ClusterSource, measured: Measured | null, shape: InstanceShape, grow: number, visit: (area: Area) => void): void {
  const { clusters, count } = lod;
  const fallback = lod.boundingBox ?? (measured && measuredBox(measured, shape, measuredScratch));
  const clusterOf = (start: number, size: number, box: Box3 | null, minScale?: number, maxScale?: number) => {
    if (size <= 0 || box?.isEmpty()) return;
    area.start = start;
    area.size = size;
    area.low = minScale ?? measured?.minScale ?? 0;
    area.high = maxScale ?? measured?.maxScale ?? (box && shape.extent > 0 ? box.getSize(size3).length() / shape.extent : Infinity);
    area.box = box && grownBox.copy(box).expandByScalar(shape.originReach * area.high * (grow - 1));
    visit(area);
  };
  if (!clusters) return clusterOf(0, count, fallback);
  for (const { start, count: size, boundingBox, minScale, maxScale } of clusters) clusterOf(start, Math.min(size, count - start), boundingBox, minScale, maxScale);
}

/**
 * Bound every cluster of `lod` into `bounds`, its survivors grown by up to `grow`: what the level meshes are culled and
 * boxed by, which three's Box3.setFromObject reads. Unbounded instances give an infinite sphere and an empty box.
 */
export function boundClusters(lod: ClusterSource, measured: Measured | null, shape: InstanceShape, grow: number, bounds: { sphere: Sphere; box: Box3 }): void {
  let unbounded = false;
  bounds.box.makeEmpty();
  forEachArea(lod, measured, shape, grow, ({ box }) => {
    if (box) bounds.box.union(box);
    else unbounded = true;
  });
  if (unbounded) bounds.sphere.set(bounds.sphere.center.set(0, 0, 0), Infinity);
  else if (bounds.box.isEmpty()) bounds.sphere.makeEmpty();
  else bounds.box.getBoundingSphere(bounds.sphere);
}

/** What a camera sees of a Lod's instances (see `ClusterView.see`). */
export class ClusterView {
  /** The ranges the camera sees, start and count, flat, clipped to `count`. */
  readonly ranges: number[] = [];
  /** How many instances the ranges hold. */
  instances = 0;
  /** Whether every range seen lies wholly inside the camera's frustum. */
  inside = true;
  /** The heights the instances of every cluster within cullDistance can have, shortest and tallest: what loads. */
  readonly heights: [number, number][] = [];
  /** The same, of the clusters seen: what draws. */
  readonly seen: [number, number][] = [];
  /** Whether nothing bounds the instances: a storage instanceMatrix with neither clusters nor a boundingBox. */
  unbounded = false;

  /** See the instances of `lod` from `camera` through `frustum`, both in the Lod's space, thinned out by `cull`. */
  see(lod: ClusterSource, measured: Measured | null, shape: InstanceShape, frustum: Frustum, camera: LocalCamera, cull: Cull | null): void {
    this.ranges.length = this.heights.length = this.seen.length = 0;
    this.instances = 0;
    this.inside = true;
    this.unbounded = false;
    const grow = cull?.survivors ? MAX_SURVIVOR_SCALE : 1;
    forEachArea(lod, measured, shape, grow, ({ start, size, box, low, high }) => {
      if (!box) this.unbounded = true;
      if (cull && box && box.distanceToPoint(cull.eye) >= cull.far) return;
      const heights = heightsIn(box, low, high * grow, shape, camera);
      this.heights.push(heights);
      if (box && !frustum.intersectsBox(box)) return;
      this.seen.push(heights);
      this.ranges.push(start, size);
      this.instances += size;
      this.inside &&= box !== null && inside(frustum, box);
    });
  }
}

/** What clusters a Lod's instances: the InstancedMesh-shaped fields of a Lod. */
export interface ClusterSource {
  readonly count: number;
  readonly boundingBox: Box3 | null;
  readonly clusters: readonly LodCluster[] | undefined;
}

/** The box around `measured`'s instances at every level and its sway. */
export function measuredBox({ originBox, maxScale }: Measured, shape: InstanceShape, into = new Box3()): Box3 {
  if (originBox.isEmpty()) return into.makeEmpty();
  return into.copy(originBox).expandByScalar(shape.originReach * maxScale);
}

/**
 * The heights on `camera`'s screen that instances inside `box` (anywhere for none) scaled from `low` to `high` can have:
 * the shortest at its farthest, the tallest at its nearest.
 */
function heightsIn(box: Box3 | null, low: number, high: number, { source }: InstanceShape, { eye, scale, ortho }: LocalCamera): [number, number] {
  const diameter = 2 * source.radius * scale;
  if (ortho) return [diameter * low, diameter * high];
  if (!box) return [0, Infinity];
  const near = Math.max(box.distanceToPoint(eye), 1e-6);
  return [(diameter * low) / farthest(box, eye), (diameter * high) / near];
}

/** The distance from `point` to the farthest point of `box`. */
function farthest(box: Box3, point: Vector3): number {
  const { min, max } = box;
  return Math.hypot(
    Math.max(Math.abs(point.x - min.x), Math.abs(point.x - max.x)),
    Math.max(Math.abs(point.y - min.y), Math.abs(point.y - max.y)),
    Math.max(Math.abs(point.z - min.z), Math.abs(point.z - max.z)),
  );
}

/** Whether `box` lies wholly inside `frustum`: its corner nearest each plane's outside lies inside. */
function inside(frustum: Frustum, box: Box3): boolean {
  return frustum.planes.every(({ normal, constant }) => {
    const x = normal.x > 0 ? box.min.x : box.max.x;
    const y = normal.y > 0 ? box.min.y : box.max.y;
    const z = normal.z > 0 ? box.min.z : box.max.z;
    return normal.x * x + normal.y * y + normal.z * z + constant > 0;
  });
}

/**
 * Throws unless `clusters` are ranges of a Lod's `capacity` instances, disjoint, each with a box and its scales as
 * `LodCluster` says. Disjointness is checked again only once a range changed: `last` holds the ranges last checked.
 */
export function checkClusters(clusters: readonly LodCluster[], capacity: number, last: number[]): void {
  let changed = last.length !== clusters.length * 2;
  clusters.forEach(({ start, count, boundingBox, minScale, maxScale }, i) => {
    if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > capacity)
      throw new RangeError(`Lod: cluster ${i}, ${count} instances from ${start}, passes the ${capacity} of its instanceMatrix`);
    if (!isBox3(boundingBox)) throw new TypeError(`Lod: cluster ${i} has no boundingBox`);
    if (minScale !== undefined && !(minScale >= 0 && Number.isFinite(minScale))) throw new RangeError(`Lod: cluster ${i}'s minScale must be finite and >= 0, not ${minScale}`);
    if (maxScale !== undefined && !(maxScale >= (minScale ?? 0) && Number.isFinite(maxScale)))
      throw new RangeError(`Lod: cluster ${i}'s maxScale must be finite and >= its minScale, not ${maxScale}`);
    if (last[2 * i] !== start || last[2 * i + 1] !== count) changed = true;
  });
  if (!changed) return;
  last.length = 0;
  for (const { start, count } of clusters) last.push(start, count);
  const sorted = [...clusters.keys()].filter((i) => at(clusters, i).count > 0).sort((a, b) => at(clusters, a).start - at(clusters, b).start);
  for (let k = 1; k < sorted.length; k++) {
    const [before, after] = [at(sorted, k - 1), at(sorted, k)];
    if (at(clusters, before).start + at(clusters, before).count > at(clusters, after).start)
      throw new RangeError(`Lod: clusters ${before} and ${after} overlap: clusters are disjoint`);
  }
}

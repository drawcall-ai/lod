import type { Box3, Vector3 } from "three/webgpu";
import { INTERSECTED, NOT_INTERSECTED, type ShapecastIntersection } from "three-mesh-bvh";
import type { Hit, Shading } from "./shading.js";
import type { Source } from "./source.js";

/**
 * Casts rays at the source and finds the nearest hit the material keeps: the back of a
 * single-sided surface and cut-out points are passed through, as three draws neither.
 * One walk through the BVH, boxes nearest first and skipped once they start beyond the
 * best hit so far, triangles tested inline (Möller–Trumbore); nothing is allocated per ray.
 */
export class Tracer {
  /** after `cast`, the triangle hit (in the source's index) and the hit's weights for its second and third corners */
  triangle = -1;
  w1 = 0;
  w2 = 0;
  private ox = 0;
  private oy = 0;
  private oz = 0;
  private dx = 0;
  private dy = 0;
  private dz = 0;
  /** 1 / direction, per axis */
  private ix = 0;
  private iy = 0;
  private iz = 0;
  private best = Infinity;
  private cutout = false;
  private facing: Vector3 | null = null;
  private readonly callbacks: {
    boundsTraverseOrder: (box: Box3) => number;
    intersectsBounds: (box: Box3, isLeaf: boolean, score: number | undefined) => ShapecastIntersection;
    intersectsRange: (offset: number, count: number) => boolean;
  };

  constructor(
    private readonly source: Source,
    private readonly shading: Shading,
  ) {
    this.callbacks = {
      boundsTraverseOrder: (box) => this.enter(box),
      intersectsBounds: (_box, _isLeaf, score) => (score !== undefined && score <= this.best ? INTERSECTED : NOT_INTERSECTED),
      intersectsRange: (offset, count) => {
        for (let j = offset; j < offset + count; j++) this.intersect(j);
        return false;
      },
    };
  }

  /**
   * Cast from `origin` along unit `direction` up to `far`; `facing` decides which side of
   * a surface is its front (null: both sides stop the ray). Returns "opaque" with `triangle`, `w1`, `w2` set; else
   * "cutout" if it passed a cut-out point, else "back" (nothing kept).
   */
  cast(origin: Vector3, direction: Vector3, far: number, facing: Vector3 | null): Hit {
    this.ox = origin.x;
    this.oy = origin.y;
    this.oz = origin.z;
    this.dx = direction.x;
    this.dy = direction.y;
    this.dz = direction.z;
    this.ix = 1 / direction.x;
    this.iy = 1 / direction.y;
    this.iz = 1 / direction.z;
    this.best = far;
    this.triangle = -1;
    this.cutout = false;
    this.facing = facing;
    this.source.bvh.shapecast(this.callbacks);
    if (this.triangle >= 0) return "opaque";
    return this.cutout ? "cutout" : "back";
  }

  /** Distance along the ray to where it enters `box`; Infinity if it misses it before `best`. */
  private enter({ min, max }: Box3): number {
    let near = 0;
    let far = this.best;
    // Slab test per axis; along an axis the ray does not move, it is inside or misses.
    if (this.dx === 0) {
      if (this.ox < min.x || this.ox > max.x) return Infinity;
    } else {
      const a = (min.x - this.ox) * this.ix;
      const b = (max.x - this.ox) * this.ix;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
    if (this.dy === 0) {
      if (this.oy < min.y || this.oy > max.y) return Infinity;
    } else {
      const a = (min.y - this.oy) * this.iy;
      const b = (max.y - this.oy) * this.iy;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
    if (this.dz === 0) {
      if (this.oz < min.z || this.oz > max.z) return Infinity;
    } else {
      const a = (min.z - this.oz) * this.iz;
      const b = (max.z - this.oz) * this.iz;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
    return near <= far ? near : Infinity;
  }

  /** Test triangle `j` (in BVH order). */
  private intersect(j: number): void {
    const c = this.source.corners;
    const o = j * 9;
    const ax = c[o] ?? 0;
    const ay = c[o + 1] ?? 0;
    const az = c[o + 2] ?? 0;
    const e1x = c[o + 3] ?? 0;
    const e1y = c[o + 4] ?? 0;
    const e1z = c[o + 5] ?? 0;
    const e2x = c[o + 6] ?? 0;
    const e2y = c[o + 7] ?? 0;
    const e2z = c[o + 8] ?? 0;
    const { dx, dy, dz } = this;
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det === 0) return;
    const inverse = 1 / det;
    const sx = this.ox - ax;
    const sy = this.oy - ay;
    const sz = this.oz - az;
    const u = (sx * px + sy * py + sz * pz) * inverse;
    if (u < 0 || u > 1) return;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inverse;
    if (v < 0 || u + v > 1) return;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inverse;
    if (t < 0 || t >= this.best) return;
    const triangle = this.source.order[j];
    if (triangle === undefined) throw new Error("@drawcall/lod: ray state broken");
    const hit = this.shading.test(triangle, u, v, this.facing);
    if (hit === "cutout") this.cutout = true;
    if (hit !== "opaque") return;
    this.best = t;
    this.triangle = triangle;
    this.w1 = u;
    this.w2 = v;
  }
}

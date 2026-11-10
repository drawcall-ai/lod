import { Box3, Vector3, type Material, type Mesh } from "three/webgpu";
import { MeshoptSimplifier } from "meshoptimizer";
import { at } from "../at.js";
import { triangleArea } from "../source/surface.js";
import { isTexture } from "../three.js";

// Simplifying cards: the alpha-tested quads foliage draws (needles, leaves), which simplify decimates card by card rather
// than collapsing their edges.

/** Per material of `mesh`, whether it alpha-tests a texture, so draws cards. */
export function cardMaterials(mesh: Mesh): boolean[] {
  const materials: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.map((m) => m.alphaTest > 0 && ["map" in m && m.map, "alphaMap" in m && m.alphaMap].some(isTexture));
}

/**
 * About `ratio` of the cards (connected parts, touching where vertices share a position)
 * of the triangles `indices`, spread evenly over them by meshopt's point simplifier on the
 * cards' centres. Each picked card is enlarged about its centre, in `positions`, so the picked
 * cards cover as much area as all did; a card larger than most grows only as far as a
 * card of the median size does, or a long spray would reach far out of the crown, and no
 * card grows past the bounds of all, which a level must stay inside.
 * Edge collapse would instead shrink and warp each card, and so cut most of an
 * alpha-tested texture (needles, leaves) away.
 */
export function decimateCards(indices: Uint32Array, positions: Float32Array, ratio: number): Uint32Array {
  const { card, count } = cards(indices, positions);
  const corner = (t: number, k: number) => indices[t * 3 + k] ?? 0;
  const point = new Vector3();
  const area = new Float64Array(count);
  const centre = Array.from({ length: count }, () => new Vector3());
  const corners = new Uint32Array(count);
  card.forEach((c, t) => {
    area[c] = (area[c] ?? 0) + triangleArea(positions, 3, indices, t * 3);
    for (let k = 0; k < 3; k++) at(centre, c).add(point.fromArray(positions, corner(t, k) * 3));
    corners[c] = (corners[c] ?? 0) + 3;
  });
  centre.forEach((p, c) => p.divideScalar(corners[c] ?? 1));
  const radius = new Float64Array(count);
  const box = Array.from({ length: count }, () => new Box3());
  const bounds = new Box3();
  card.forEach((c, t) => {
    for (let k = 0; k < 3; k++) {
      point.fromArray(positions, corner(t, k) * 3);
      radius[c] = Math.max(radius[c] ?? 0, point.distanceTo(at(centre, c)));
      at(box, c).expandByPoint(point);
      bounds.expandByPoint(point);
    }
  });
  const median = Float64Array.from(radius).sort()[count >> 1] ?? 0;
  // The most each card can grow about its centre and stay inside `bounds`.
  const fit = centre.map((p, c) => {
    const { min, max } = at(box, c);
    let most = Infinity;
    for (const axis of ["x", "y", "z"] as const) {
      if (max[axis] > p[axis]) most = Math.min(most, (bounds.max[axis] - p[axis]) / (max[axis] - p[axis]));
      if (min[axis] < p[axis]) most = Math.min(most, (p[axis] - bounds.min[axis]) / (p[axis] - min[axis]));
    }
    return Math.max(1, most);
  });

  const picked = new Uint8Array(count);
  const target = Math.max(1, Math.round(count * ratio));
  const points = Float32Array.from(centre.flatMap((p) => p.toArray()));
  for (const c of target < count ? MeshoptSimplifier.simplifyPoints(points, 3, target) : picked.keys()) picked[c] = 1;

  // `scale` enlarges a median card; bisect for the one at which the picked cards cover what all did.
  const grow = (c: number, scale: number) => Math.min(scale, fit[c] ?? 1, Math.max(1, (scale * median) / Math.max(radius[c] ?? 0, 1e-30)));
  const covered = (scale: number) => area.reduce((sum, a, c) => sum + (picked[c] ? a * grow(c, scale) ** 2 : 0), 0);
  const total = area.reduce((sum, a) => sum + a, 0);
  let [low, high] = [1, 1];
  while (covered(high) < total && high < 1e6) high *= 2;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (covered(mid) < total) low = mid;
    else high = mid;
  }

  const out: number[] = [];
  const moved = new Uint8Array(positions.length / 3);
  card.forEach((c, t) => {
    if (!picked[c]) return;
    const p = at(centre, c);
    for (let k = 0; k < 3; k++) {
      const v = corner(t, k);
      out.push(v);
      if (moved[v]) continue;
      moved[v] = 1;
      point
        .fromArray(positions, v * 3)
        .sub(p)
        .multiplyScalar(grow(c, high))
        .add(p)
        .toArray(positions, v * 3);
    }
  });
  return Uint32Array.from(out);
}

/** The card of each triangle, numbered 0..count-1. */
function cards(indices: Uint32Array, positions: Float32Array): { card: Uint32Array; count: number } {
  const remap = MeshoptSimplifier.generatePositionRemap(positions, 3);
  const parent = Uint32Array.from(remap.keys());
  const root = (vertex: number) => {
    let v = remap[vertex] ?? vertex;
    while (parent[v] !== v) v = parent[v] = parent[parent[v] ?? v] ?? v;
    return v;
  };
  for (let i = 0; i < indices.length; i += 3) {
    const a = root(indices[i] ?? 0);
    parent[root(indices[i + 1] ?? 0)] = a;
    parent[root(indices[i + 2] ?? 0)] = a;
  }
  const number = new Map<number, number>();
  const card = new Uint32Array(indices.length / 3);
  for (let t = 0; t < card.length; t++) {
    const r = root(indices[t * 3] ?? 0);
    let c = number.get(r);
    if (c === undefined) number.set(r, (c = number.size));
    card[t] = c;
  }
  return { card, count: number.size };
}

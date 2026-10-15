/**
 * A triangle list laid out in its UVs on a `size`² texel grid: per texel, the triangle
 * covering its centre (-1 for none) and that point's weights for the triangle's second
 * and third corners.
 */
export interface Raster {
  size: number;
  triangles: Int32Array;
  weights: Float32Array;
  /** texels covered */
  covered: number;
  /** texels whose centre more than one triangle covers: UVs that overlap */
  overlaps: number;
}

/**
 * Rasterize `index`'s triangles at their `uvs` on the CPU. A texel centre on an edge two
 * triangles share belongs to exactly one of them (a fill rule), so a clean layout has no
 * overlaps; folded or stacked UVs do. Where triangles overlap, the first keeps the texel.
 */
export function rasterize(uvs: Float32Array, index: Uint32Array, size: number): Raster {
  const triangles = new Int32Array(size * size).fill(-1);
  const weights = new Float32Array(size * size * 2);
  let covered = 0;
  let overlaps = 0;
  const p = new Float64Array(6);
  for (let t = 0; t < index.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const v = index[t * 3 + k] ?? 0;
      p[k * 2] = (uvs[v * 2] ?? 0) * size;
      p[k * 2 + 1] = (uvs[v * 2 + 1] ?? 0) * size;
    }
    const [ax = 0, ay = 0, bx = 0, by = 0, cx = 0, cy = 0] = p;
    const area = edge(ax, ay, bx, by, cx, cy);
    if (area === 0) continue;
    // Corners in counter-clockwise order for the fill rule; weights stay the input's.
    const sign = area > 0 ? 1 : -1;
    const ownA = owns(bx, by, cx, cy, sign);
    const ownB = owns(cx, cy, ax, ay, sign);
    const ownC = owns(ax, ay, bx, by, sign);
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5));
    const x1 = Math.min(size - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5));
    const y1 = Math.min(size - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const qx = x + 0.5;
        const qy = y + 0.5;
        const wa = edge(bx, by, cx, cy, qx, qy) * sign;
        const wb = edge(cx, cy, ax, ay, qx, qy) * sign;
        const wc = edge(ax, ay, bx, by, qx, qy) * sign;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        if ((wa === 0 && !ownA) || (wb === 0 && !ownB) || (wc === 0 && !ownC)) continue;
        const texel = y * size + x;
        if (triangles[texel] !== -1) {
          overlaps++;
          continue;
        }
        covered++;
        triangles[texel] = t;
        weights[texel * 2] = (wb * sign) / area;
        weights[texel * 2 + 1] = (wc * sign) / area;
      }
  }
  return { size, triangles, weights, covered, overlaps };
}

/**
 * Twice the signed area of (p, q, r). Computed from the edge's lexicographically smaller
 * end, so two triangles sharing the edge get exactly opposite values: the fill rule
 * relies on that.
 */
function edge(px: number, py: number, qx: number, qy: number, rx: number, ry: number): number {
  if (px > qx || (px === qx && py > qy)) return -((px - qx) * (ry - qy) - (py - qy) * (rx - qx));
  return (qx - px) * (ry - py) - (qy - py) * (rx - px);
}

/** Whether the edge p → q (reversed for clockwise triangles) owns centres exactly on it. */
function owns(px: number, py: number, qx: number, qy: number, sign: number): boolean {
  const dx = (qx - px) * sign;
  const dy = (qy - py) * sign;
  return dy > 0 || (dy === 0 && dx < 0);
}

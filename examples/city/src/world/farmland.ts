import * as THREE from "three/webgpu";
import { Random } from "../content/random.ts";
import { Crop, type Land, Use } from "./land.ts";
import { type Forest, inForest, type Road, type Spot, spot } from "./plan.ts";
import { EXTENT, type Terrain } from "./terrain.ts";

/** Mean size of the regions fields are laid out in (m). */
const REGION = 520;
const CROPS: { crop: Crop; weight: number }[] = [
  { crop: Crop.Wheat, weight: 0.3 },
  { crop: Crop.Pasture, weight: 0.24 },
  { crop: Crop.Ploughed, weight: 0.14 },
  { crop: Crop.Stubble, weight: 0.12 },
  { crop: Crop.Rapeseed, weight: 0.1 },
  { crop: Crop.None, weight: 0.1 },
];

/**
 * The open country outside the town cut into parcels — wheat, rapeseed, pasture, stubble,
 * ploughed land, rough meadow. The land is split into regions of half a kilometre, each
 * laid out along its nearest road: strips 60–150 m wide across it, each strip cut into
 * fields a few hundred metres long, so fields are rectangles and long strips that line
 * up with each other and with the roads.
 * Grassland stays around every house, in the town's core and in a band along the forests.
 * Half the boundaries between parcels grow hedgerows with the odd tree in them; the main
 * roads outside town are lined with trees. Plants go through `add`.
 */
export function farmland(
  land: Land,
  terrain: Terrain,
  roads: Road[],
  keep: { town: { x: number; z: number; radius: number }; houses: Spot[]; forests: Forest[] },
  r: Random,
  add: (id: string, spot: Spot) => void,
): void {
  const { town } = keep;
  // grassland stays around every house (its garden or yard) and as a meadow along the forests
  const gardens = new Uint8Array(GRID * GRID);
  for (const h of keep.houses)
    for (let dz = -35; dz <= 35; dz += 5)
      for (let dx = -35; dx <= 35; dx += 5) {
        const g = gridCell(h.x + dx, h.z + dz);
        if (g !== null && Math.hypot(dx, dz) <= 35) gardens[g] = 1;
      }
  // regions of about half a kilometre, each laid out along the nearest road
  const span = Math.ceil(EXTENT / REGION) + 2;
  const side = 2 * span;
  const segments = roads.flatMap((road) => road.points.slice(1).map((b, i) => ({ a: road.points[i] ?? b, b })));
  const regions = Array.from({ length: side * side }, (_, i) => {
    const x = ((i % side) - span + 0.5 + r.range(-0.35, 0.35)) * REGION;
    const z = (Math.floor(i / side) - span + 0.5 + r.range(-0.35, 0.35)) * REGION;
    return { x, z, id: i, angle: roadAngle(segments, x, z), width: r.range(60, 150), length: r.range(160, 420) };
  });
  for (let k = 0; k < land.size * land.size; k++) {
    if (land.useOf(k) !== Use.Lawn) continue;
    const { x, z } = land.centre(k);
    if (Math.hypot(x - town.x, z - town.z) < town.radius * 0.75 || gardens[gridCell(x, z) ?? 0] === 1) continue;
    if (keep.forests.some((f) => inForest(f, x, z, 50))) continue;
    const gx = Math.floor(x / REGION) + span;
    const gz = Math.floor(z / REGION) + span;
    let region = null;
    let nearest = Infinity;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const g = regions[(gz + dz) * side + gx + dx];
        const d = g ? (x - g.x) ** 2 + (z - g.z) ** 2 : Infinity;
        if (g && d < nearest) {
          nearest = d;
          region = g;
        }
      }
    if (!region) throw new Error("farmland: no region");
    // strips across the region's grain, each cut into fields of its own length
    const ca = Math.cos(region.angle);
    const sa = Math.sin(region.angle);
    const u = (x - region.x) * ca + (z - region.z) * sa;
    const v = -(x - region.x) * sa + (z - region.z) * ca;
    const strip = Math.floor(v / region.width);
    const length = region.length * (0.6 + 0.8 * hash(region.id, strip, 0));
    const field = Math.floor((u + hash(region.id, strip, 1) * length) / length);
    const id = Math.floor(hash(region.id, strip, field + 2) * 2 ** 30) + 1;
    const parcel = new Random(id);
    land.sow(k, pick(parcel), parcel.next(), region.angle + (parcel.chance(0.2) ? Math.PI / 2 : 0), id);
  }
  hedgerows(land, terrain, r, add);
  avenues(roads, land, terrain, town, r, add);
}

/** A coarse 10 m grid over the square, for marking where gardens are. */
const GRID = Math.ceil((2 * EXTENT) / 10);
function gridCell(x: number, z: number): number | null {
  const i = Math.floor((x + EXTENT) / 10);
  const j = Math.floor((z + EXTENT) / 10);
  return i < 0 || j < 0 || i >= GRID || j >= GRID ? null : j * GRID + i;
}

/** Direction (radians, x/z plane) of the road segment nearest x, z. */
function roadAngle(segments: { a: THREE.Vector2; b: THREE.Vector2 }[], x: number, z: number): number {
  let best = 0;
  let nearest = Infinity;
  for (const { a, b } of segments) {
    const dx = b.x - a.x;
    const dz = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.y) * dz) / (dx * dx + dz * dz)));
    const d = Math.hypot(x - a.x - t * dx, z - a.y - t * dz);
    if (d < nearest) {
      nearest = d;
      best = Math.atan2(dz, dx);
    }
  }
  return best;
}

/** A number in [0, 1) from three integers. */
function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(c, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function pick(r: Random): Crop {
  let u = r.next();
  for (const { crop, weight } of CROPS) if ((u -= weight) < 0) return crop;
  return Crop.Pasture;
}

/** Shrubs, and now and then a tree, along about half the boundaries between parcels. */
function hedgerows(land: Land, terrain: Terrain, r: Random, add: (id: string, spot: Spot) => void) {
  const n = land.size;
  const hedged = (a: number, b: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return (Math.imul(lo * 73856093 + hi * 19349663, 0x9e3779b1) >>> 0) % 100 < 55;
  };
  for (let k = 0; k < n * n; k++) {
    const p = land.parcelOf(k);
    if (p === 0) continue;
    const right = (k % n) + 1 < n ? land.parcelOf(k + 1) : 0;
    const below = k + n < n * n ? land.parcelOf(k + n) : 0;
    const other = right !== 0 && right !== p ? right : below !== 0 && below !== p ? below : 0;
    if (other === 0 || !hedged(p, other) || !r.chance(0.42)) continue;
    const { x, z } = land.centre(k);
    const angle = r.range(0, Math.PI * 2);
    const pick = r.next();
    if (pick < 0.1) add("tree_small_02", spot(terrain, x, z, angle, r.range(2.0, 3.0)));
    else if (pick < 0.18) add("searsia_lucida", spot(terrain, x, z, angle, r.range(1.6, 2.2)));
    else add("shrub_02", spot(terrain, x, z, angle, r.range(1.2, 2.0)));
  }
}

/** Trees along the main roads outside town, both sides, in stretches. */
function avenues(
  roads: Road[],
  land: Land,
  terrain: Terrain,
  town: { x: number; z: number; radius: number },
  r: Random,
  add: (id: string, spot: Spot) => void,
) {
  for (const road of roads.filter((x) => x.kind === "main")) {
    let along = 0;
    let lined = r.chance(0.6);
    road.points.forEach((p, i) => {
      const q = road.points[i + 1];
      if (!q) return;
      const dir = q.clone().sub(p);
      const length = dir.length();
      dir.normalize();
      const out = new THREE.Vector2(-dir.y, dir.x);
      for (let t = 0; t < length; t += 14) {
        along += 14;
        if (along > 220) {
          along = 0;
          lined = r.chance(0.6);
        }
        if (!lined) continue;
        const at = p.clone().addScaledVector(dir, t);
        if (Math.hypot(at.x - town.x, at.y - town.z) < town.radius + 40) continue;
        for (const side of [1, -1]) {
          const tree = at.clone().addScaledVector(out, side * (road.width / 2 + 3.5));
          const use = land.at(tree.x, tree.y);
          if (use === Use.Lawn || use === Use.Crop) add("tree_small_02", spot(terrain, tree.x, tree.y, r.range(0, 6.3), r.range(2.3, 3.0)));
        }
      }
    });
  }
}

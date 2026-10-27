import * as THREE from "three/webgpu";
import type { HouseParams } from "../content/house/index.ts";
import type { Random } from "../content/random.ts";
import { footing, inRect, PAVEMENT, spot, type Rect, type Road, type Spot } from "./plan.ts";
import { fence, frontHedge, garden } from "./gardens.ts";
import type { Terrain } from "./terrain.ts";

const BLOCK = { u: 84, v: 64 };
export const STREET_WIDTH = 7;

/** Within this distance of the centre streets have pavements and lots are narrow. */
const CORE = 280;
const SIGN_NAMES = ["Maple St", "Church Rd", "Mill Lane", "Oak Ave", "High St", "Elm St"];

export interface Town {
  roads: Road[];
  /** Garden paths and driveways. */
  paths: Road[];
  /** Where the church stands (its front facing the plaza). */
  church: Spot;
  /** Garden things by name (see `content/garden.ts`): sheds, letterboxes, greenhouses… */
  garden: Map<string, Spot[]>;
  /** Clipped hedge sections (2 m, running along the spot's +x). */
  hedges: Spot[];
  /** The east–west axis through the centre: the main road continues it on both sides. */
  mainRoad: THREE.Vector2[];
  plaza: Rect;
  houses: { variant: number; spot: Spot }[];
  fences: Spot[];
  signs: Map<string, Spot[]>;
  models: Map<string, Spot[]>;
}

/**
 * A small town on a street grid turned by `angle`: a cobbled plaza at the centre, a dense
 * core with pavements, suburbs thinning out to `radius`. Houses face their street from
 * behind a front garden with a picket fence; lamps, hydrants, benches, bins, signs and
 * parked cars line the streets.
 */
export function town(centre: { x: number; z: number; angle: number; radius: number }, variants: HouseParams[], terrain: Terrain, r: Random): Town {
  const u = new THREE.Vector2(Math.cos(centre.angle), Math.sin(centre.angle));
  const v = new THREE.Vector2(-u.y, u.x);
  const node = (i: number, j: number) => new THREE.Vector2(centre.x, centre.z).addScaledVector(u, i * BLOCK.u).addScaledVector(v, j * BLOCK.v);
  const reach = (p: THREE.Vector2) => p.distanceTo(new THREE.Vector2(centre.x, centre.z));
  const exists = (i: number, j: number) => reach(node(i, j)) < centre.radius * (0.85 + 0.3 * Math.sin(i * 1.7 + j * 2.3));

  const segments: { a: THREE.Vector2; b: THREE.Vector2; core: boolean }[] = [];
  const degree = new Map<string, number>();
  const link = (i: number, j: number, di: number, dj: number) => {
    if (!exists(i, j) || !exists(i + di, j + dj)) return;
    // the centre row is the main road; outer streets drop out now and then
    if (dj === 0 && j === 0) return;
    const a = node(i, j);
    const b = node(i + di, j + dj);
    if (reach(a.clone().add(b).multiplyScalar(0.5)) > CORE && r.chance(0.18)) return;
    segments.push({ a, b, core: reach(a) < CORE && reach(b) < CORE });
    for (const key of [`${i},${j}`, `${i + di},${j + dj}`]) degree.set(key, (degree.get(key) ?? 0) + 1);
  };
  const span = Math.ceil(centre.radius / Math.min(BLOCK.u, BLOCK.v)) + 1;
  for (let j = -span; j <= span; j++)
    for (let i = -span; i <= span; i++) {
      link(i, j, 1, 0);
      link(i, j, 0, 1);
    }
  const row = Array.from({ length: 2 * span + 1 }, (_, k) => k - span).filter((i) => exists(i, 0));
  const mainRoad = row.map((i) => node(i, 0));
  for (const i of row) degree.set(`${i},0`, (degree.get(`${i},0`) ?? 0) + 2);

  const roads: Road[] = segments.map((s) => ({ points: [s.a, s.b], width: STREET_WIDTH, kind: "street", pavement: s.core }));
  const plaza: Rect = { x: centre.x, z: centre.z, halfX: 26, halfZ: 22, angle: centre.angle };
  // the church on the plaza's north side, its front toward the plaza
  const churchAt = new THREE.Vector2(centre.x, centre.z).addScaledVector(v, -(plaza.halfZ + 12));
  const town: Town = {
    roads,
    paths: [],
    church: { ...spot(terrain, churchAt.x, churchAt.y, -centre.angle), y: footing(terrain, churchAt.x, churchAt.y, 14) },
    garden: new Map(),
    hedges: [],
    mainRoad,
    plaza,
    houses: [],
    fences: [],
    signs: new Map(),
    models: new Map(),
  };
  const add = (id: string, at: Spot) => town.models.set(id, [...(town.models.get(id) ?? []), at]);

  // every street, the main road through town included, gets lots on both sides
  const sides = [...segments, ...mainRoad.slice(1).map((b, k) => ({ a: mainRoad[k] ?? b, b, core: reach(b) < CORE }))];
  const taken: { x: number; z: number; radius: number }[] = [{ x: churchAt.x, z: churchAt.y, radius: 15 }];
  const free = (x: number, z: number, radius: number) =>
    !inRect(plaza, x, z, radius + 4) &&
    taken.every((t) => Math.hypot(t.x - x, t.z - z) > t.radius + radius) &&
    sides.every((s) => distanceToSegment(x, z, s.a, s.b) > radius + STREET_WIDTH / 2 + PAVEMENT.width);
  for (const s of sides) {
    const along = s.b.clone().sub(s.a);
    const length = along.length();
    along.normalize();
    const kerb = STREET_WIDTH / 2 + (s.core ? PAVEMENT.width : 0.6);
    for (const side of [1, -1]) {
      const out = new THREE.Vector2(-along.y, along.x).multiplyScalar(side);
      const at = (t: number, offset: number) => s.a.clone().addScaledVector(along, t).addScaledVector(out, offset);
      // street furniture
      for (let t = side > 0 ? 6 : 21; t < length - 6; t += 30) {
        const p = at(t, kerb + 0.4);
        add("street_lamp_01", spot(terrain, p.x, p.y, Math.atan2(out.x, out.y) + Math.PI / 2));
      }
      if (r.chance(0.4)) place(add, "fire_hydrant", at(r.range(10, length - 10), kerb + 0.5), Math.atan2(-out.x, -out.y), terrain);
      if (s.core && r.chance(0.5)) {
        const t = r.range(12, length - 14);
        place(add, "painted_wooden_bench", at(t, kerb + (s.core ? 0.9 : 1.6)), Math.atan2(-out.x, -out.y), terrain);
        place(add, "metal_trash_can", at(t + 1.6, kerb + 0.8), r.range(0, 6.3), terrain);
      }
      if (r.chance(0.15)) place(add, "utility_box_01", at(r.range(8, length - 8), kerb + 0.6), Math.atan2(-out.x, -out.y), terrain);
      // lots: a house behind a front garden, fenced along the pavement
      const frontage = s.core ? 12 : 18;
      for (let t = STREET_WIDTH + 4 + frontage / 2; t < length - STREET_WIDTH - 4 - frontage / 2; t += frontage + r.range(0, 4)) {
        if (!s.core && r.chance(Math.min(0.85, (reach(at(t, 0)) - CORE) / (centre.radius * 1.4)))) continue;
        const variant = r.int(0, variants.length - 1);
        const p = variants[variant];
        if (!p) throw new Error(`no house variant ${variant}`);
        const setback = s.core ? r.range(3, 4.5) : r.range(5, 8);
        const c = at(t, kerb + setback + p.depth / 2);
        const radius = Math.hypot(p.width, p.depth) / 2 + 0.8;
        if (!free(c.x, c.y, radius)) continue;
        taken.push({ x: c.x, z: c.y, radius });
        const angle = Math.atan2(-out.x, -out.y);
        town.houses.push({ variant, spot: { ...spot(terrain, c.x, c.y, angle), y: footing(terrain, c.x, c.y, radius) } });
        // along the pavement: a picket fence, a clipped hedge, or open lawn
        const boundary = r.next();
        if (boundary < 0.45) fence(town.fences, terrain, at, along, t, frontage, kerb + 0.5, side);
        else if (boundary < 0.85) frontHedge(town.hedges, terrain, at, along, t, frontage, kerb + 0.6);
        garden(town, add, terrain, r, { at, along, side, t, frontage, kerb, setback, house: p, angle, core: s.core });
      }
    }
  }
  // a name sign at the corner of each crossing
  let names = 0;
  for (const [key, count] of degree) {
    if (count < 3) continue;
    const [i = 0, j = 0] = key.split(",").map(Number);
    const p = node(i, j)
      .addScaledVector(u, STREET_WIDTH / 2 + 1)
      .addScaledVector(v, STREET_WIDTH / 2 + 1);
    const name = SIGN_NAMES[names++ % SIGN_NAMES.length] ?? "Main St";
    town.signs.set(name, [...(town.signs.get(name) ?? []), spot(terrain, p.x, p.y, centre.angle + r.range(-0.1, 0.1))]);
  }
  plazaFurniture(plaza, terrain, add);
  return town;
}

function place(add: (id: string, spot: Spot) => void, id: string, p: THREE.Vector2, angle: number, terrain: Terrain, scale = 1) {
  add(id, spot(terrain, p.x, p.y, angle, scale));
}

/** Benches facing in along the plaza's long sides, planters and bins between them, lamps on the corners. */
function plazaFurniture(plaza: Rect, terrain: Terrain, add: (id: string, spot: Spot) => void) {
  const ax = new THREE.Vector2(Math.cos(plaza.angle), Math.sin(plaza.angle));
  const az = new THREE.Vector2(-ax.y, ax.x);
  const at = (x: number, z: number) => new THREE.Vector2(plaza.x, plaza.z).addScaledVector(ax, x).addScaledVector(az, z);
  for (const side of [1, -1])
    for (let x = -18; x <= 18; x += 6) {
      const bench = at(x, side * (plaza.halfZ - 3));
      add("painted_wooden_bench", spot(terrain, bench.x, bench.y, -plaza.angle + (side > 0 ? Math.PI : 0)));
      const planter = at(x + 3, side * (plaza.halfZ - 3));
      add(x % 12 === 0 ? "metal_trash_can" : "planter_box_01", spot(terrain, planter.x, planter.y, -plaza.angle));
    }
  for (const [x, z] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const) {
    const lamp = at(x * (plaza.halfX - 2), z * (plaza.halfZ - 2));
    add("street_lamp_01", spot(terrain, lamp.x, lamp.y, -plaza.angle));
  }
}

function distanceToSegment(x: number, z: number, a: THREE.Vector2, b: THREE.Vector2): number {
  const dx = b.x - a.x;
  const dz = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.y) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - a.x - t * dx, z - a.y - t * dz);
}

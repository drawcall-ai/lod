import * as THREE from "three/webgpu";
import type { HouseParams } from "../../public/house/params.ts";
import type seedrandom from "seedrandom";
import { footing, inRect, PAVEMENT, spot, type Rect, type Road, type Spot } from "./plan.ts";
import { fence, frontHedge, garden, type Fixture } from "./gardens.ts";
import type { Terrain } from "./terrain.ts";

/** The street names on the street signs at the crossings, each a street sign of its own (see props.ts). */
export const STREET_NAMES = ["Maple St", "Church Rd", "Mill Lane", "Oak Ave", "High St", "Elm St"] as const;
export type StreetName = (typeof STREET_NAMES)[number];

const BLOCK = { u: 84, v: 64 };
export const STREET_WIDTH = 7;

/** Within this distance of the centre streets have pavements and lots are narrow. */
const CORE = 280;

export interface Town {
  roads: Road[];
  /** Garden paths and driveways. */
  paths: Road[];
  /** Where the church stands (its front facing the plaza). */
  church: Spot;
  /** Garden fixtures by name: sheds, letterboxes, greenhouses… */
  fixtures: Map<Fixture, Spot[]>;
  /** Clipped hedge sections (2 m, running along the spot's +x). */
  hedges: Spot[];
  /** The east–west axis through the centre: the main road continues it on both sides. */
  mainRoad: THREE.Vector2[];
  plaza: Rect;
  houses: { variant: number; spot: Spot }[];
  fences: Spot[];
  streetSigns: Map<StreetName, Spot[]>;
  models: Map<string, Spot[]>;
}

/**
 * A small town on a street grid turned by `angle`: a cobbled plaza at the centre, a dense
 * core with pavements, suburbs thinning out to `radius`. Houses face their street from
 * behind a front garden with a picket fence; lamps, hydrants, benches, bins, signs and
 * parked cars line the streets.
 */
export function town(centre: { x: number; z: number; angle: number; radius: number }, variants: HouseParams[], terrain: Terrain, r: seedrandom.PRNG): Town {
  const u = new THREE.Vector2(Math.cos(centre.angle), Math.sin(centre.angle));
  const v = new THREE.Vector2(-u.y, u.x);
  const node = (i: number, j: number) => new THREE.Vector2(centre.x, centre.z).addScaledVector(u, i * BLOCK.u).addScaledVector(v, j * BLOCK.v);
  const reach = (p: THREE.Vector2) => p.distanceTo(new THREE.Vector2(centre.x, centre.z));
  const exists = (i: number, j: number) => reach(node(i, j)) < centre.radius * (0.85 + 0.3 * Math.sin(i * 1.7 + j * 2.3));

  const segments: { a: THREE.Vector2; b: THREE.Vector2; core: boolean }[] = [];
  const junctions = new Map<string, { i: number; j: number; streets: number }>();
  const meet = (i: number, j: number, streets: number) => {
    const junction = junctions.get(`${i},${j}`) ?? { i, j, streets: 0 };
    junction.streets += streets;
    junctions.set(`${i},${j}`, junction);
  };
  const link = (i: number, j: number, di: number, dj: number) => {
    if (!exists(i, j) || !exists(i + di, j + dj)) return;
    // the centre row is the main road; outer streets drop out now and then
    if (dj === 0 && j === 0) return;
    const a = node(i, j);
    const b = node(i + di, j + dj);
    if (reach(a.clone().add(b).multiplyScalar(0.5)) > CORE && r() < 0.18) return;
    segments.push({ a, b, core: reach(a) < CORE && reach(b) < CORE });
    meet(i, j, 1);
    meet(i + di, j + dj, 1);
  };
  const span = Math.ceil(centre.radius / Math.min(BLOCK.u, BLOCK.v)) + 1;
  for (let j = -span; j <= span; j++)
    for (let i = -span; i <= span; i++) {
      link(i, j, 1, 0);
      link(i, j, 0, 1);
    }
  const row = Array.from({ length: 2 * span + 1 }, (_, k) => k - span).filter((i) => exists(i, 0));
  const mainRoad = row.map((i) => node(i, 0));
  for (const i of row) meet(i, 0, 2);

  const roads: Road[] = segments.map((s) => ({ points: [s.a, s.b], width: STREET_WIDTH, kind: "street", pavement: s.core }));
  const plaza: Rect = { x: centre.x, z: centre.z, halfX: 26, halfZ: 22, angle: centre.angle };
  // the church on the plaza's north side, its front toward the plaza
  const churchAt = new THREE.Vector2(centre.x, centre.z).addScaledVector(v, -(plaza.halfZ + 12));
  const town: Town = {
    roads,
    paths: [],
    church: { ...spot(terrain, churchAt.x, churchAt.y, -centre.angle), y: footing(terrain, churchAt.x, churchAt.y, 14) },
    fixtures: new Map(),
    hedges: [],
    mainRoad,
    plaza,
    houses: [],
    fences: [],
    streetSigns: new Map(),
    models: new Map(),
  };
  const add = (id: string, at: Spot) => town.models.set(id, [...(town.models.get(id) ?? []), at]);

  // every street, the main road through town included, gets lots on both sides
  const sides = [...segments, ...[...pairs(mainRoad)].map(([a, b]) => ({ a, b, core: reach(b) < CORE }))];
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
      if (r() < 0.4) place(add, "fire_hydrant", at(10 + (length - 10 - 10) * r(), kerb + 0.5), Math.atan2(-out.x, -out.y), terrain);
      if (s.core && r() < 0.5) {
        const t = 12 + (length - 14 - 12) * r();
        place(add, "painted_wooden_bench", at(t, kerb + (s.core ? 0.9 : 1.6)), Math.atan2(-out.x, -out.y), terrain);
        place(add, "metal_trash_can", at(t + 1.6, kerb + 0.8), 6.3 * r(), terrain);
      }
      if (r() < 0.15) place(add, "utility_box_01", at(8 + (length - 8 - 8) * r(), kerb + 0.6), Math.atan2(-out.x, -out.y), terrain);
      // lots: a house behind a front garden, fenced along the pavement
      const frontage = s.core ? 12 : 18;
      for (let t = STREET_WIDTH + 4 + frontage / 2; t < length - STREET_WIDTH - 4 - frontage / 2; t += frontage + 4 * r()) {
        if (!s.core && r() < Math.min(0.85, (reach(at(t, 0)) - CORE) / (centre.radius * 1.4))) continue;
        const variant = Math.floor(variants.length * r());
        const p = variants[variant];
        if (!p) throw new Error(`no house variant ${variant}`);
        const setback = s.core ? 3 + 1.5 * r() : 5 + 3 * r();
        const c = at(t, kerb + setback + p.depth / 2);
        const radius = Math.hypot(p.width, p.depth) / 2 + 0.8;
        if (!free(c.x, c.y, radius)) continue;
        taken.push({ x: c.x, z: c.y, radius });
        const angle = Math.atan2(-out.x, -out.y);
        town.houses.push({ variant, spot: { ...spot(terrain, c.x, c.y, angle), y: footing(terrain, c.x, c.y, radius) } });
        // along the pavement: a picket fence, a clipped hedge, or open lawn
        const boundary = r();
        if (boundary < 0.45) fence(town.fences, terrain, at, along, t, frontage, kerb + 0.5, side);
        else if (boundary < 0.85) frontHedge(town.hedges, terrain, at, along, t, frontage, kerb + 0.6);
        garden(town, add, terrain, r, { at, along, side, t, frontage, kerb, setback, house: p, angle, core: s.core });
      }
    }
  }
  // a street sign at the corner of each crossing, the street names taking turns
  const names = cycle(STREET_NAMES);
  for (const { i, j, streets } of junctions.values()) {
    if (streets < 3) continue;
    const p = node(i, j)
      .addScaledVector(u, STREET_WIDTH / 2 + 1)
      .addScaledVector(v, STREET_WIDTH / 2 + 1);
    const name = names.next().value;
    town.streetSigns.set(name, [...(town.streetSigns.get(name) ?? []), spot(terrain, p.x, p.y, centre.angle + (-0.1 + 0.2 * r()))]);
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

/** Each item of `items` with the one after it. */
function* pairs<T>(items: readonly T[]): Generator<[T, T]> {
  let previous: T | undefined;
  for (const item of items) {
    if (previous !== undefined) yield [previous, item];
    previous = item;
  }
}

/** `items` over and over. */
function* cycle<T>(items: readonly T[]): Generator<T, never> {
  if (items.length === 0) throw new Error("cycle: no items");
  for (;;) yield* items;
}

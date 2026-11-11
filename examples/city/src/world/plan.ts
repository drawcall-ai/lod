import * as THREE from "three/webgpu";
import { HOUSE_VARIANTS, houseParams, type HouseParams } from "../../public/house/params.ts";
import seedrandom from "seedrandom";
import { type Forest, forestClearings, forestEdge } from "./zones.ts";
import { country, crossRoad } from "./country.ts";
import { banks, CREEK, crossings } from "./creek.ts";
import { farmland } from "./farmland.ts";
import { Land, Use } from "./land.ts";
import { Terrain } from "./terrain.ts";
import { town, type SignName } from "./town.ts";

/** Where one copy of something stands: on the ground at x, z, turned by `angle` about y. */
export interface Spot {
  x: number;
  y: number;
  z: number;
  angle: number;
  scale: number;
}

export interface Road {
  /** Centre line, in x/z. */
  points: THREE.Vector2[];
  width: number;
  /** Roads and tracks, and in gardens paved paths and terraces, gravel drives and walks, planted beds. */
  kind: "main" | "street" | "track" | "path" | "drive" | "bed";
  /** Raised pavements on both sides (town core). */
  pavement: boolean;
}

/** A rotated rectangle in x/z: centre, half sizes along its own axes, turn (see `axes`). */
export interface Rect {
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  angle: number;
}

export type Field = Rect;

/** Pavement width on each side of a town-core street, and the kerb height. */
export const PAVEMENT = { width: 2.2, kerb: 0.12 };

/**
 * Everything the world holds and where, decided once from a seed. Counts per kind are
 * whatever the layout produces; each list is drawn by one kind of LOD setup.
 */
export interface Plan {
  terrain: Terrain;
  land: Land;
  roads: Road[];
  plaza: Rect;
  fields: Field[];
  forests: Forest[];
  houses: { variant: number; spot: Spot }[];
  /** Fence bays (2.4 m, running along the spot's +x). */
  fences: Spot[];
  /** Garden things by name (each in its own public/ folder). */
  garden: Map<string, Spot[]>;
  hedges: Spot[];
  church: Spot;
  /** Street-name signs, by name. */
  signs: Map<SignName, Spot[]>;
  /** Fetched models (props, trees, shrubs) by manifest id. */
  models: Map<string, Spot[]>;
}

/** The world's x/z axes of a rect: its own +x and +z. Same convention as the terrain shader's fields. */
export function axes(angle: number): { x: THREE.Vector2; z: THREE.Vector2 } {
  return { x: new THREE.Vector2(Math.cos(angle), Math.sin(angle)), z: new THREE.Vector2(-Math.sin(angle), Math.cos(angle)) };
}

export function inRect(r: Rect, x: number, z: number, margin = 0): boolean {
  const { x: ax, z: az } = axes(r.angle);
  const dx = x - r.x;
  const dz = z - r.z;
  return Math.abs(dx * ax.x + dz * ax.y) <= r.halfX + margin && Math.abs(dx * az.x + dz * az.y) <= r.halfZ + margin;
}

/** Whether x, z lies in the forest (`margin` metres past its edge), outside its clearings. */
export function inForest(f: Forest, x: number, z: number, margin = 0): boolean {
  const dx = x - f.x;
  const dz = z - f.z;
  if (Math.hypot(dx, dz) > forestEdge(f.radius, Math.atan2(dz, dx), f.phase) + margin) return false;
  return forestClearings(f.radius, f.phase).every((c) => Math.hypot(dx - c.x, dz - c.z) > c.radius - margin);
}

export const TOWN = { x: -900, z: -560, angle: 0.21, radius: 560 };

// Corn fields: half sizes are multiples of the 12 m corn block, rows run along each field's
// x. The first holds the origin, where the tour ends on a single plant.
const FIELDS: Field[] = [
  { x: 54, z: 54, halfX: 156, halfZ: 108, angle: 0 },
  { x: 520, z: 420, halfX: 132, halfZ: 96, angle: 0.3 },
  { x: -580, z: 700, halfX: 120, halfZ: 84, angle: -0.15 },
  { x: 900, z: -420, halfX: 144, halfZ: 108, angle: 0.1 },
  { x: 1380, z: 640, halfX: 120, halfZ: 120, angle: 0.5 },
];

const FORESTS: Forest[] = [
  { x: -300, z: -120, radius: 112, phase: 0.4 },
  { x: 1150, z: -1150, radius: 304, phase: 1.3 },
  { x: -1500, z: 900, radius: 272, phase: 2.2 },
  { x: 320, z: 1350, radius: 232, phase: 3.1 },
  { x: 1750, z: -150, radius: 192, phase: 4.0 },
  { x: -250, z: -1350, radius: 192, phase: 5.2 },
  { x: -1800, z: -1500, radius: 176, phase: 0.9 },
];

export function plan(seed: number): Plan {
  const r = seedrandom(String(seed));
  const flats = [{ x: TOWN.x, z: TOWN.z, radius: TOWN.radius * 0.8 }, ...FIELDS.map((f) => ({ x: f.x, z: f.z, radius: Math.hypot(f.halfX, f.halfZ) }))];
  const terrain = new Terrain({ seed, flats, creek: { course: CREEK.course, depth: CREEK.depth, crossings: crossings(CREEK.course, crossRoad(TOWN)) } });
  const land = new Land();
  for (const f of FIELDS) land.paint(Use.Field, f.x - 250, f.z - 250, f.x + 250, f.z + 250, (x, z) => inRect(f, x, z));
  for (const f of FORESTS)
    land.paint(Use.Forest, f.x - f.radius * 1.6, f.z - f.radius * 1.6, f.x + f.radius * 1.6, f.z + f.radius * 1.6, (x, z) => inForest(f, x, z));

  const variants = Array.from({ length: HOUSE_VARIANTS }, (_, i) => houseParams(i));
  const built = town(TOWN, variants, terrain, r);
  const roads = [...built.roads, ...country(TOWN, built.mainRoad, FIELDS), ...built.paths];
  for (const road of roads) {
    const width = road.width + (road.pavement ? 2 * PAVEMENT.width : 0) + 1;
    road.points.forEach((p, i) => {
      const q = road.points[i + 1];
      if (q) land.strip(Use.Paved, p.x, p.y, q.x, q.y, width);
    });
  }
  const plaza = built.plaza;
  land.paint(Use.Paved, plaza.x - 60, plaza.z - 60, plaza.x + 60, plaza.z + 60, (x, z) => inRect(plaza, x, z));

  const models = built.models;
  const add = (id: string, spot: Spot) => {
    const list = models.get(id) ?? [];
    list.push(spot);
    models.set(id, list);
  };
  const houses = [...built.houses, ...farms(roads, variants, terrain, land, r, add)];
  for (const { variant, spot } of houses) {
    const p = variants[variant];
    if (!p) throw new Error(`no house variant ${variant}`);
    const footprint: Rect = { x: spot.x, z: spot.z, halfX: p.width / 2 + 1, halfZ: p.depth / 2 + 1, angle: -spot.angle };
    land.paint(Use.Paved, spot.x - 12, spot.z - 12, spot.x + 12, spot.z + 12, (x, z) => inRect(footprint, x, z));
  }
  banks(land, terrain, r, add);
  farmland(land, terrain, roads, { town: TOWN, houses: houses.map((h) => h.spot), forests: FORESTS }, r, add);
  groves(terrain, land, r, add);
  return {
    terrain,
    land,
    roads,
    plaza,
    fields: FIELDS,
    forests: FORESTS,
    houses,
    fences: built.fences,
    garden: built.garden,
    hedges: built.hedges,
    church: built.church,
    signs: built.signs,
    models,
  };
}

/** A spot on the ground at x, z. */
export function spot(terrain: Terrain, x: number, z: number, angle: number, scale = 1): Spot {
  return { x, y: terrain.height(x, z), z, angle, scale };
}

/**
 * Farmhouses along the main road outside town, each with a car, crates and a few trees.
 * Returns the houses; the rest goes through `add`.
 */
function farms(roads: Road[], variants: HouseParams[], terrain: Terrain, land: Land, r: seedrandom.PRNG, add: (id: string, spot: Spot) => void) {
  const houses: Plan["houses"] = [];
  for (const road of roads.filter((x) => x.kind === "main")) {
    road.points.forEach((p, i) => {
      const q = road.points[i + 1];
      if (!q || i % 9 !== 0 || Math.hypot(p.x - TOWN.x, p.y - TOWN.z) < TOWN.radius + 80 || r() >= 0.55) return;
      const along = q.clone().sub(p).normalize();
      const side = r() < 0.5 ? 1 : -1;
      const out = new THREE.Vector2(-along.y, along.x).multiplyScalar(side);
      const variant = Math.floor(variants.length * r());
      const params = variants[variant];
      if (!params) return;
      const centre = p.clone().addScaledVector(out, road.width / 2 + 9 + params.depth / 2);
      const clear = (x: number, z: number) => land.at(x, z) === Use.Lawn;
      const reach = Math.hypot(params.width, params.depth) / 2 + 3;
      if (![0, 1, 2, 3].every((k) => clear(centre.x + reach * Math.cos(k * 1.57), centre.y + reach * Math.sin(k * 1.57))) || !clear(centre.x, centre.y)) return;
      // the front (+z of the house) faces the road
      const angle = Math.atan2(-out.x, -out.y);
      houses.push({ variant, spot: { ...spot(terrain, centre.x, centre.y, angle), y: footing(terrain, centre.x, centre.y, reach) } });
      const yard = centre.clone().addScaledVector(along, (params.width / 2 + 4) * (r() < 0.5 ? 1 : -1));
      add("covered_car", spot(terrain, yard.x, yard.y, angle + (-0.3 + 0.6 * r())));
      for (let k = 0; k < 3; k++) add("wooden_crate_01", spot(terrain, yard.x + (-3 + 6 * r()), yard.y + (-3 + 6 * r()), 6.3 * r()));
      for (let k = 0; k < 2 + Math.floor(4 * r()); k++) {
        const behind = centre
          .clone()
          .addScaledVector(out, 10 + 12 * r())
          .addScaledVector(along, -14 + 28 * r());
        if (clear(behind.x, behind.y)) add("tree_small_02", spot(terrain, behind.x, behind.y, 6.3 * r(), 1.4 + 0.8 * r()));
      }
    });
  }
  return houses;
}

/** The lowest ground under a footprint `reach` around x, z: a house stands on it with its plinth showing. */
export function footing(terrain: Terrain, x: number, z: number, reach: number): number {
  let low = Infinity;
  for (let k = 0; k < 8; k++) low = Math.min(low, terrain.height(x + reach * Math.cos((k * Math.PI) / 4), z + reach * Math.sin((k * Math.PI) / 4)));
  return Math.min(low, terrain.height(x, z));
}

/** Small groups of trees and shrubs scattered over open lawn. */
function groves(terrain: Terrain, land: Land, r: seedrandom.PRNG, add: (id: string, spot: Spot) => void) {
  for (let g = 0; g < 70; g++) {
    const cx = -2100 + 4200 * r();
    const cz = -2100 + 4200 * r();
    if (land.at(cx, cz) !== Use.Lawn) continue;
    for (let k = 0; k < 3 + Math.floor(7 * r()); k++) {
      const x = cx + (-18 + 36 * r());
      const z = cz + (-18 + 36 * r());
      if (land.at(x, z) !== Use.Lawn) continue;
      const pick = r();
      const angle = Math.PI * 2 * r();
      if (pick < 0.5) add("tree_small_02", spot(terrain, x, z, angle, 1.5 + 1 * r()));
      else if (pick < 0.75) add("searsia_lucida", spot(terrain, x, z, angle, 1.2 + 0.8 * r()));
      else add("shrub_02", spot(terrain, x, z, angle, 0.8 + 0.5 * r()));
    }
  }
}

import * as THREE from "three";
import type { HouseParams } from "../content/house/index.ts";
import type { Random } from "../content/random.ts";
import { spot, type Spot } from "./plan.ts";
import type { Terrain } from "./terrain.ts";
import { STREET_WIDTH, type Town } from "./town.ts";

/** Length of one clipped hedge section (m). */
export const HEDGE = 2;

/** A lot's position along its street: `at(t, offset)` maps along-street and out-from-the-centre-line metres to x/z. */
interface Lot {
  at: (t: number, offset: number) => THREE.Vector2;
  along: THREE.Vector2;
  /** Which side of the street (1 left, -1 right, looking along it). */
  side: number;
  /** The lot's middle along the street, its width, the kerb's and the house front's offsets. */
  t: number;
  frontage: number;
  kerb: number;
  setback: number;
  house: HouseParams;
  angle: number;
  core: boolean;
}

/**
 * A front and back garden: a path from the gate to the door, often a gravel drive with
 * the car on it, shrubs along the house front and a tree in front, clipped hedges or
 * planted beds down the sides; behind the house a terrace, a gravel path, trees, and on
 * some lots a shed, a vegetable bed or a greenhouse, a washing line, a swing. The lawn
 * is what is left.
 */
export function garden(town: Town, add: (id: string, at: Spot) => void, terrain: Terrain, r: Random, lot: Lot) {
  const { at, t, frontage, kerb, setback, house, angle } = lot;
  const front = kerb + setback;
  const back = front + house.depth;
  town.paths.push({ points: [at(t, kerb + 0.3), at(t, front)], width: 1.1, kind: "path", pavement: false });
  const driveSide = r.chance(0.5) ? 1 : -1;
  const driveT = t + driveSide * (house.width / 2 + 1.9);
  const drive = !lot.core && r.chance(0.5) && Math.abs(driveT - t) < frontage / 2 - 1.6;
  if (drive) {
    town.paths.push({ points: [at(driveT, kerb - 0.4), at(driveT, front + house.depth * 0.7)], width: 2.8, kind: "drive", pavement: false });
    const car = at(driveT, front + 1.5);
    add("covered_car", spot(terrain, car.x, car.y, angle + Math.PI + r.range(-0.05, 0.05)));
  } else if (r.chance(0.3)) {
    const car = at(t + r.range(-3, 3), STREET_WIDTH / 2 - 1.2);
    add("covered_car", spot(terrain, car.x, car.y, Math.atan2(lot.along.x, lot.along.y) + (lot.side > 0 ? 0 : Math.PI)));
  }
  // a bed of shrubs along the house front, either side of the door
  for (let x = -house.width / 2 + 0.6; x < house.width / 2 - 0.4; x += r.range(0.8, 1.3)) {
    if (Math.abs(x) < 0.9) continue;
    const g = at(t + x, front - 0.8);
    add("searsia_lucida", spot(terrain, g.x, g.y, r.range(0, 6.3), r.range(0.4, 0.6)));
  }
  // the letterbox by the gate, and often a tree or a big shrub in the front garden
  const box = at(t + 0.9, kerb + 0.7);
  item(town, "letterbox", spot(terrain, box.x, box.y, angle));
  if (setback > 3.5 && r.chance(0.55)) {
    const g = at(t + (r.chance(0.5) ? 1 : -1) * r.range(2.5, frontage / 2 - 1.5), kerb + setback * 0.45);
    if (r.chance(0.5)) add("tree_small_02", spot(terrain, g.x, g.y, r.range(0, 6.3), r.range(1.1, 1.6)));
    else add("searsia_lucida", spot(terrain, g.x, g.y, r.range(0, 6.3), r.range(0.9, 1.3)));
  }
  // hedges down the sides of the lot, in 2 m sections along the lot line
  // a section runs along its +x: turned to point away from the street
  const away = new THREE.Vector2(-lot.along.y, lot.along.x).multiplyScalar(lot.side);
  const inward = Math.atan2(-away.y, away.x);
  const hedged = new Set<number>();
  for (const s of [-1, 1]) {
    if (!r.chance(0.5) || (drive && s === driveSide)) continue;
    hedged.add(s);
    for (let d = kerb + 1.2; d + HEDGE < back + (lot.core ? 7 : 13); d += HEDGE) {
      const g = at(t + (s * frontage) / 2, d);
      town.hedges.push(spot(terrain, g.x, g.y, inward));
    }
  }
  // the back garden: a terrace off the house, a gravel path down the garden, planted beds
  // along the sides, and what a family keeps there
  const yard = lot.core ? 7 : 13;
  const terrace = Math.min(house.width - 1, 5);
  town.paths.push({ points: [at(t, back), at(t, back + 3)], width: terrace, kind: "path", pavement: false });
  town.paths.push({ points: [at(t, back + 3), at(t - driveSide * 1.5, back + yard - 1)], width: 0.8, kind: "drive", pavement: false });
  if (r.chance(0.55)) item(town, "patio set", spot(terrain, at(t + 1, back + 1.6).x, at(t + 1, back + 1.6).y, r.range(0, 6.3)));
  for (const s of [-1, 1]) {
    if (hedged.has(s)) continue;
    const from = at(t + s * (frontage / 2 - 0.7), kerb + 1.2);
    const to = at(t + s * (frontage / 2 - 0.7), back + yard);
    town.paths.push({ points: [from, to], width: 1.2, kind: "bed", pavement: false });
    const length = from.distanceTo(to);
    for (let d = 0.4; d < length; d += r.range(0.7, 1.1)) {
      const g = from.clone().lerp(to, d / length);
      const pick = r.next();
      const id = pick < 0.45 ? "searsia_lucida" : pick < 0.75 ? "fern_02" : "nettle_plant";
      add(id, spot(terrain, g.x, g.y, r.range(0, 6.3), id === "searsia_lucida" ? r.range(0.45, 0.7) : r.range(0.7, 1.0)));
    }
  }
  for (let k = 0; k < r.int(lot.core ? 0 : 1, 2); k++) {
    const g = at(t + r.range(-frontage / 2 + 2, frontage / 2 - 2), back + r.range(yard * 0.5, yard));
    add(r.chance(0.6) ? "tree_small_02" : "searsia_lucida", spot(terrain, g.x, g.y, r.range(0, 6.3), r.range(1.3, 2.1)));
  }
  if (r.chance(0.4)) {
    const g = at(t - driveSide * (frontage / 2 - 2), back + yard - 2);
    item(town, "shed", spot(terrain, g.x, g.y, angle + (r.chance(0.5) ? 0 : Math.PI / 2)));
  }
  if (lot.core) return;
  if (r.chance(0.35)) {
    // a vegetable bed in rows
    const a = at(t + driveSide * frontage * 0.22, back + 5);
    const b = at(t + driveSide * frontage * 0.22, back + 9);
    town.paths.push({ points: [a, b], width: 1.8, kind: "bed", pavement: false });
    for (let row = -1; row <= 1; row++)
      for (let d = 0.3; d < 4; d += 0.5) {
        const g = a
          .clone()
          .lerp(b, d / 4)
          .add(lot.along.clone().multiplyScalar(row * 0.55));
        add("fern_02", spot(terrain, g.x, g.y, r.range(0, 6.3), r.range(0.3, 0.4)));
      }
  } else if (r.chance(0.18)) {
    const g = at(t + driveSide * frontage * 0.22, back + 7);
    item(town, "greenhouse", spot(terrain, g.x, g.y, angle));
  }
  if (r.chance(0.25)) {
    const g = at(t - driveSide * 1, back + yard * 0.6);
    item(town, "washing line", spot(terrain, g.x, g.y, Math.atan2(-lot.along.y, lot.along.x)));
  }
  if (r.chance(0.15)) {
    const g = at(t + driveSide * 2, back + yard - 3);
    item(town, "swing", spot(terrain, g.x, g.y, angle));
  }
}

/** Adds a garden thing (see `content/garden.ts`) by name. */
function item(town: Town, name: string, at: Spot): void {
  town.garden.set(name, [...(town.garden.get(name) ?? []), at]);
}

/** A clipped hedge along the lot front, open at the gate: two runs of 2 m sections. */
export function frontHedge(
  hedges: Spot[],
  terrain: Terrain,
  at: (t: number, offset: number) => THREE.Vector2,
  along: THREE.Vector2,
  t: number,
  frontage: number,
  offset: number,
) {
  // a section runs along its +x: turned so it follows the street
  const angle = Math.atan2(-along.y, along.x);
  for (const [from, to] of [
    [t - frontage / 2 + 0.3, t - 0.8],
    [t + 0.8, t + frontage / 2 - 0.3],
  ] as const)
    for (let s = from; s + HEDGE <= to + 0.01; s += HEDGE) {
      const start = at(s, offset);
      hedges.push(spot(terrain, start.x, start.y, angle));
    }
}

/** Fence bays along the lot front, leaving a gate in the middle. */ /** Fence bays along the lot front, leaving a gate in the middle. */
export function fence(
  fences: Spot[],
  terrain: Terrain,
  at: (t: number, offset: number) => THREE.Vector2,
  along: THREE.Vector2,
  t: number,
  frontage: number,
  offset: number,
  side: number,
) {
  const bay = 2.4;
  const gate = 0.8;
  // a bay runs along its +x; flip it on the far side so the pickets face the street
  const angle = Math.atan2(-along.y, along.x) + (side > 0 ? 0 : Math.PI);
  for (const [from, to] of [
    [t - frontage / 2, t - gate],
    [t + gate, t + frontage / 2],
  ] as const) {
    for (let s = from; s + bay <= to + 0.01; s += bay) {
      const start = at(side > 0 ? s : s + bay, offset);
      fences.push(spot(terrain, start.x, start.y, angle));
    }
  }
}

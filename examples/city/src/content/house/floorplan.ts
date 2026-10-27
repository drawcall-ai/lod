import * as THREE from "three/webgpu";
import { columnBounds, facades } from "./facades.ts";
import { heights, type HouseParams, wallThickness as t } from "./params.ts";
import type { Opening } from "./wall.ts";

/** Which wall of a room's box: the front (+z, the house's door side), back, east (+x) or west. */
export type Side = "front" | "back" | "east" | "west";
export type Kind = "stairwell" | "living" | "kitchen" | "dining" | "study" | "bedroom" | "bath" | "attic";

export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

/** A hole in one wall of a room: centred at `along` on that wall's axis (x for front/back, z for east/west), bottom at `y`. */
export interface Hole {
  side: Side;
  along: number;
  y: number;
  w: number;
  h: number;
}

/** A doorway between two rooms; the room that hangs the leaf has `leaf` set (how far it stands open, radians). */
export interface Doorway extends Hole {
  to: number;
  leaf: number | null;
}

/** A straight flight of stairs in the stairwell, from storey `from` up to the next, along the band x0..x1. */
export interface Flight {
  x0: number;
  x1: number;
  /** z where the bottom step starts and where the top step ends. */
  zStart: number;
  zEnd: number;
  y0: number;
  y1: number;
  steps: number;
}

export interface Room {
  kind: Kind;
  box: Box;
  /** Openings of the outer walls in this room's walls: windows, and the front door in the stairwell. */
  windows: Hole[];
  doors: Doorway[];
  /** A hatch in the floor (the attic) or ceiling (the stairwell below it), x/z extent, and the room it leads to. */
  hatch: { x0: number; x1: number; z0: number; z1: number; in: "floor" | "ceiling"; to: number } | null;
}

export interface FloorPlan {
  rooms: Room[];
  /** The stairwell's flights and the landings between them. */
  flights: Flight[];
  /** Landings: per upper storey, its floor level and the hall's area minus the stair opening below it. */
  landings: { y: number; opening: { x0: number; x1: number; z0: number; z1: number } }[];
}

/** Half the thickness of an inner partition: rooms stop this short of it on each side. */
const PARTITION = 0.06;
/** Floor slab between storeys: a room's ceiling is this far below the next storey's floor. */
export const SLAB = 0.25;
/** Space kept clear at the front and back of the stairwell for the doors into the rooms. */
const ZONE = 1.0;
const DOOR = { w: 0.82, h: 2.05 };
const RISE = 0.2;

/**
 * The floor plan behind a house's windows, from the same params as `house`. The window
 * column with the front door is a stairwell, as tall as the house: a hall on the ground
 * floor, straight flights up that turn at each storey, and a landing at every upper
 * storey. On both sides of it each storey has a front and a back room, each with a door
 * onto the hall or landing, near the outer wall where the flights leave the floor free:
 * living room, dining room, study and kitchen downstairs; bedrooms and a bathroom
 * upstairs. Under a high roof an attic over everything, reached by a ladder through a
 * hatch from the top landing. Every outer opening falls in a room and every room is
 * reachable from the front door; `floorPlan` checks both and throws otherwise.
 */
export function floorPlan(p: HouseParams): FloorPlan {
  const xs = columnBounds(p);
  const middle = Math.floor(p.columns / 2);
  const hall = { x0: xs[middle] ?? 0, x1: xs[middle + 1] ?? 0 };
  const inner = { x0: -p.width / 2 + t, x1: p.width / 2 - t, z0: -p.depth / 2 + t, z1: p.depth / 2 - t };
  const storey = (k: number) => ({ y0: p.plinth + k * p.floorHeight, y1: p.plinth + (k + 1) * p.floorHeight - SLAB });
  const rooms: Room[] = [];
  const add = (kind: Kind, box: Box) => rooms.push({ kind, box, windows: [], doors: [], hatch: null }) - 1;

  const top = storey(p.floors - 1);
  const hallBox = { x0: hall.x0 + PARTITION, x1: hall.x1 - PARTITION, y0: p.plinth, y1: top.y1, z0: inner.z0, z1: inner.z1 };
  const stairwell = add("stairwell", hallBox);
  const { flights, landings } = stairs(hallBox, p, storey);

  for (let k = 0; k < p.floors; k++) {
    const { y0, y1 } = storey(k);
    const kinds: Kind[] =
      p.floors === 1
        ? ["living", "bedroom", "bath", "kitchen"]
        : k === 0
          ? ["living", "dining", "study", "kitchen"]
          : ["bedroom", "bedroom", k === 1 ? "bedroom" : "study", "bath"];
    const sides = [
      { x0: inner.x0, x1: hall.x0 - PARTITION, door: "east" as const },
      { x0: hall.x1 + PARTITION, x1: inner.x1, door: "west" as const },
    ];
    sides.forEach((s, i) => {
      for (const front of [true, false]) {
        const kind = kinds[i * 2 + (front ? 0 : 1)];
        if (!kind) throw new Error("floor plan: no room kind");
        const room = add(kind, { x0: s.x0, x1: s.x1, y0, y1, z0: front ? PARTITION : inner.z0, z1: front ? inner.z1 : -PARTITION });
        // the doorway onto the hall, in the clear zone by the outer wall
        const along = front ? inner.z1 - ZONE / 2 : inner.z0 + ZONE / 2;
        connect(rooms, room, s.door, stairwell, s.door === "east" ? "west" : "east", { along, y: y0, ...DOOR }, k === 0 && front ? 0.3 : 1.2 - 0.3 * i);
      }
    });
  }

  const { eave, ridge, slope } = heights(p);
  if (ridge - eave > 2.4) {
    // under the ridge, as far out as the roof (its deck 0.3 m thick) leaves 2 m of headroom
    const y0 = p.plinth + p.floors * p.floorHeight;
    const reach = Math.min(inner.z1, (ridge - 0.3 - y0 - 2) / slope);
    if (reach < 1) throw new Error("floor plan: the attic is too low for its gable windows");
    const attic = add("attic", { x0: inner.x0, x1: inner.x1, y0, y1: y0 + 2, z0: -reach, z1: reach });
    // the hatch over the top landing, beside the last flight's opening
    const last = flights[flights.length - 1];
    const x = last && last.x0 > (hall.x0 + hall.x1) / 2 ? hall.x0 + 0.5 : hall.x1 - 0.5;
    const hatch = { x0: x - 0.35, x1: x + 0.35, z0: -0.45, z1: 0.45 };
    const a = rooms[attic];
    const s = rooms[stairwell];
    if (!a || !s) throw new Error("floor plan: rooms missing");
    a.hatch = { ...hatch, in: "floor", to: stairwell };
    s.hatch = { ...hatch, in: "ceiling", to: attic };
  }

  for (const [side, opening] of outerOpenings(p)) {
    const room = rooms.find((r) => onWall(r.box, inner, side) && spans(r.box, side, opening));
    if (!room) throw new Error(`floor plan: a ${side} opening at ${opening.along.toFixed(2)}, ${opening.y.toFixed(2)} opens into no room`);
    room.windows.push(opening);
  }
  checkReachable(rooms, stairwell);
  return { rooms, flights, landings };
}

/** Joins two rooms through a doorway in each one's wall; `a` hangs the leaf, open by `open` radians. */
function connect(rooms: Room[], a: number, sideA: Side, b: number, sideB: Side, hole: { along: number; y: number; w: number; h: number }, open: number) {
  rooms[a]?.doors.push({ side: sideA, ...hole, to: b, leaf: open });
  rooms[b]?.doors.push({ side: sideB, ...hole, to: a, leaf: null });
}

/**
 * The flights up the stairwell: one per storey, along the west and east sides by turns,
 * within the clear zones at the front and back; each landing is open over the flight
 * that arrives at it.
 */
function stairs(hall: Box, p: HouseParams, storey: (k: number) => { y0: number; y1: number }) {
  const flights: Flight[] = [];
  const landings: FloorPlan["landings"] = [];
  const steps = Math.round(p.floorHeight / RISE);
  const run = Math.min(0.26, (hall.z1 - hall.z0 - 2 * ZONE) / steps);
  const width = Math.min(0.95, (hall.x1 - hall.x0) * 0.42);
  for (let k = 0; k + 1 < p.floors; k++) {
    const west = k % 2 === 0;
    const x0 = west ? hall.x0 : hall.x1 - width;
    // up toward the back from the front zone, then toward the front from the back zone
    const zStart = west ? hall.z1 - ZONE : hall.z0 + ZONE;
    const zEnd = west ? zStart - steps * run : zStart + steps * run;
    flights.push({ x0, x1: x0 + width, zStart, zEnd, y0: storey(k).y0, y1: storey(k + 1).y0, steps });
    landings.push({ y: storey(k + 1).y0, opening: { x0, x1: x0 + width, z0: Math.min(zStart, zEnd), z1: Math.max(zStart, zEnd) } });
  }
  return { flights, landings };
}

/** Every window and door of the outer walls, by the wall it is in. */
function outerOpenings(p: HouseParams): [Side, Hole][] {
  const sides: Side[] = ["front", "back", "east", "west"];
  return facades(p).flatMap((f, i) => {
    const side = sides[i];
    if (!side) throw new Error("a house has four walls");
    const all: Opening[] = f.door ? [...f.windows, f.door] : f.windows;
    return all.map((o): [Side, Hole] => {
      const at = new THREE.Vector3(o.x, 0, 0).applyMatrix4(f.frame);
      return [side, { side, along: side === "front" || side === "back" ? at.x : at.z, y: o.y, w: o.w, h: o.h }];
    });
  });
}

function onWall(b: Box, inner: { x0: number; x1: number; z0: number; z1: number }, side: Side): boolean {
  return { front: b.z1 === inner.z1, back: b.z0 === inner.z0, east: b.x1 === inner.x1, west: b.x0 === inner.x0 }[side];
}

/** Whether the opening lies wholly within the box's wall on `side`. */
function spans(b: Box, side: Side, o: Hole): boolean {
  const [lo, hi] = side === "front" || side === "back" ? [b.x0, b.x1] : [b.z0, b.z1];
  return o.along - o.w / 2 >= lo && o.along + o.w / 2 <= hi && o.y >= b.y0 - 1e-6 && o.y + o.h <= b.y1;
}

/** Throws unless the front door opens into `start` and every room can be walked to from there through doorways and hatches. */
function checkReachable(rooms: Room[], start: number): void {
  const hall = rooms[start];
  if (!hall?.windows.some((w) => w.side === "front" && w.y <= hall.box.y0 + 1e-6)) throw new Error("floor plan: the front door does not open into the hall");
  const seen = new Set([start]);
  const queue = [start];
  for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
    const room = rooms[i];
    const next = [...(room?.doors.map((d) => d.to) ?? []), ...(room?.hatch ? [room.hatch.to] : [])];
    for (const to of next) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  const lost = rooms.filter((_, i) => !seen.has(i)).map((r) => r.kind);
  if (lost.length > 0) throw new Error(`floor plan: no way in to ${lost.join(", ")}`);
}

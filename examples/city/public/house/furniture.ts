import type { Materials } from "../shared/materials.ts";
import * as THREE from "three/webgpu";
import { box, type Parts, tint } from "../shared/geometry.ts";
import type seedrandom from "seedrandom";
import { pick } from "./params.ts";
import { type Box, type FloorPlan, type Flight, type Room, SLAB, type Side } from "./floorplan.ts";
import * as M from "./furnishings.ts";

/**
 * Skirting, a ceiling lamp, curtains at every window and the furniture of the room's
 * kind, stood against the wall with fewest openings. Pieces are plain boxes in the
 * proportions of real furniture: seen through a window from a few metres, the
 * silhouettes and colours carry the room.
 */
export function furnish(materials: Materials, parts: Parts, room: Room, plan: FloorPlan, r: seedrandom.PRNG): void {
  const b = room.box;
  if (room.kind === "stairwell") return stairwell(materials, parts, room, plan, r);
  skirting(materials, parts, b, r);
  lamp(materials, parts, b);
  if (room.kind !== "bath" && room.kind !== "attic") for (const w of room.windows) curtains(materials, parts, b, w, r);
  const wall = backWall(room);
  const place = (along: number, out: number) => wall.at(along, out);
  const width = wall.length;
  const depth = wall.depth;
  const fabric = () => new THREE.Color(pick(r, M.fabricColors));
  const stain = () => new THREE.Color(pick(r, M.woodColors));
  switch (room.kind) {
    case "living":
      sofa(materials, parts.at(place(0, 0.5)), fabric());
      shelf(materials, parts.at(place(width / 2 - 0.65, 0.18)), stain(), r);
      table(materials, parts.at(place(0, 1.55)), 1.0, 0.55, 0.42, stain());
      rug(materials, parts.at(place(0, 1.5)), Math.min(2.4, width - 0.6), Math.min(1.7, depth - 1.6), fabric());
      break;
    case "kitchen":
      counter(materials, parts.at(place(0, 0.3)), Math.min(width - 0.3, 3.2), r);
      table(materials, parts.at(place(0, depth * 0.6)), 1.2, 0.8, 0.75, stain());
      for (const side of [-1, 1]) chair(materials, parts.at(place(side * 0.45, depth * 0.6 + 0.55).multiply(turn(Math.PI))), stain());
      break;
    case "dining":
      table(materials, parts.at(place(0, depth / 2)), 1.6, 0.9, 0.75, stain());
      for (const side of [-1, 1])
        for (const s of [-0.45, 0.45]) chair(materials, parts.at(place(s, depth / 2 + side * 0.65).multiply(turn(side > 0 ? Math.PI : 0))), stain());
      break;
    case "bedroom":
      bed(materials, parts.at(place(0, 1.05)), fabric(), stain());
      wardrobe(materials, parts.at(place(width / 2 - 0.55, 0.3)), stain());
      table(materials, parts.at(place(-1.05, 0.25)), 0.45, 0.4, 0.5, stain());
      break;
    case "bath":
      parts.add(M.gloss(materials), tint(box(1.7, 0.55, 0.75).translate(0, 0.275, 0).applyMatrix4(place(0, 0.4)), new THREE.Color("#f2f1ec")));
      parts.add(
        M.gloss(materials),
        tint(
          box(0.6, 0.85, 0.45)
            .translate(0, 0.425, 0)
            .applyMatrix4(place(width / 2 - 0.5, 0.25)),
          new THREE.Color("#f6f5f0"),
        ),
      );
      parts.add(
        M.gloss(materials),
        tint(
          box(0.38, 0.42, 0.6)
            .translate(0, 0.21, 0)
            .applyMatrix4(place(-width / 2 + 0.45, 0.3)),
          new THREE.Color("#f6f5f0"),
        ),
      );
      break;
    case "study":
      table(materials, parts.at(place(0, 0.4)), 1.4, 0.7, 0.75, stain());
      chair(materials, parts.at(place(0, 1.0).multiply(turn(Math.PI))), stain());
      shelf(materials, parts.at(place(width / 2 - 0.6, 0.18)), stain(), r);
      break;
    case "attic":
      for (let i = 0; i < 6; i++) {
        const s = 0.35 + 0.25 * r();
        parts.add(
          M.fabric(materials),
          tint(
            box(s, s * (0.6 + 0.4 * r()), s)
              .translate(0, (s * 0.8) / 2, 0)
              .applyMatrix4(place(-width / 2 + 0.5 + (width - 1) * r(), 0.3 + 0.6 * r())),
            new THREE.Color("#a98b62"),
          ),
        );
      }
      break;
  }
}

/**
 * A wall of a room's box as a frame: `matrix` maps (u along the wall, v up from the floor,
 * n into the room) to house space, `u` turns a position on the wall's axis (x or z) into u.
 */
export function wallFrame(b: Box, side: Side): { matrix: THREE.Matrix4; length: number; u: (along: number) => number } {
  const frames: Record<Side, { origin: THREE.Vector3; dir: THREE.Vector3; length: number; u: (a: number) => number }> = {
    front: { origin: new THREE.Vector3(b.x1, b.y0, b.z1), dir: new THREE.Vector3(-1, 0, 0), length: b.x1 - b.x0, u: (a) => b.x1 - a },
    back: { origin: new THREE.Vector3(b.x0, b.y0, b.z0), dir: new THREE.Vector3(1, 0, 0), length: b.x1 - b.x0, u: (a) => a - b.x0 },
    east: { origin: new THREE.Vector3(b.x1, b.y0, b.z0), dir: new THREE.Vector3(0, 0, 1), length: b.z1 - b.z0, u: (a) => a - b.z0 },
    west: { origin: new THREE.Vector3(b.x0, b.y0, b.z1), dir: new THREE.Vector3(0, 0, -1), length: b.z1 - b.z0, u: (a) => b.z1 - a },
  };
  const f = frames[side];
  const up = new THREE.Vector3(0, 1, 0);
  // u × up points into the room
  const matrix = new THREE.Matrix4().makeBasis(f.dir, up, new THREE.Vector3().crossVectors(f.dir, up)).setPosition(f.origin);
  return { matrix, length: f.length, u: f.u };
}

/** The wall the furniture stands against, as a frame: `at(along, out)` places a piece `out` metres into the room, facing out. */
function backWall(room: Room) {
  const b = room.box;
  const count = (side: Side) => [...room.windows, ...room.doors].filter((w) => w.side === side).length;
  const sides: { side: Side; origin: THREE.Vector3; angle: number; length: number; depth: number }[] = [
    { side: "back", origin: new THREE.Vector3((b.x0 + b.x1) / 2, b.y0, b.z0), angle: 0, length: b.x1 - b.x0, depth: b.z1 - b.z0 },
    { side: "front", origin: new THREE.Vector3((b.x0 + b.x1) / 2, b.y0, b.z1), angle: Math.PI, length: b.x1 - b.x0, depth: b.z1 - b.z0 },
    { side: "west", origin: new THREE.Vector3(b.x0, b.y0, (b.z0 + b.z1) / 2), angle: Math.PI / 2, length: b.z1 - b.z0, depth: b.x1 - b.x0 },
    { side: "east", origin: new THREE.Vector3(b.x1, b.y0, (b.z0 + b.z1) / 2), angle: -Math.PI / 2, length: b.z1 - b.z0, depth: b.x1 - b.x0 },
  ];
  const wall = [...sides].sort((p, q) => count(p.side) - count(q.side) || q.length - p.length)[0];
  if (!wall) throw new Error("a room has four walls");
  const facing = new THREE.Matrix4().makeRotationY(wall.angle).setPosition(wall.origin);
  return {
    length: wall.length,
    depth: wall.depth,
    at: (along: number, out: number) => facing.clone().multiply(new THREE.Matrix4().makeTranslation(along, 0, out)),
  };
}

const turn = (angle: number) => new THREE.Matrix4().makeRotationY(angle);

function skirting(materials: Materials, parts: Parts, b: Box, r: seedrandom.PRNG) {
  const c = new THREE.Color(r() < 0.6 ? "#f2efe8" : "#6e5a48");
  const h = 0.08;
  const d = 0.012;
  const w = b.x1 - b.x0;
  const l = b.z1 - b.z0;
  parts.add(M.gloss(materials), tint(box(w, h, d).translate((b.x0 + b.x1) / 2, b.y0 + h / 2, b.z0 + d / 2), c));
  parts.add(M.gloss(materials), tint(box(w, h, d).translate((b.x0 + b.x1) / 2, b.y0 + h / 2, b.z1 - d / 2), c));
  parts.add(M.gloss(materials), tint(box(d, h, l).translate(b.x0 + d / 2, b.y0 + h / 2, (b.z0 + b.z1) / 2), c));
  parts.add(M.gloss(materials), tint(box(d, h, l).translate(b.x1 - d / 2, b.y0 + h / 2, (b.z0 + b.z1) / 2), c));
}

function lamp(materials: Materials, parts: Parts, b: Box) {
  const x = (b.x0 + b.x1) / 2;
  const z = (b.z0 + b.z1) / 2;
  parts.add(M.gloss(materials), tint(new THREE.CylinderGeometry(0.004, 0.004, 0.5, 4).translate(x, b.y1 - 0.25, z), new THREE.Color("#222222")));
  parts.add(M.shade(materials), new THREE.CylinderGeometry(0.06, 0.2, 0.18, 16, 1, true).translate(x, b.y1 - 0.58, z));
}

/** Two gathered panels beside a window, hung from a rail above it. */
function curtains(materials: Materials, parts: Parts, b: Box, w: Room["windows"][number], r: seedrandom.PRNG) {
  const c = new THREE.Color(pick(r, M.fabricColors)).lerp(new THREE.Color("#d8d2c4"), 0.35 * r());
  const f = wallFrame(b, w.side);
  const top = Math.min(w.y + w.h + 0.2, b.y1 - 0.02) - b.y0;
  const bottom = Math.max(w.y - 0.15, b.y0 + 0.02) - b.y0;
  const panel = 0.32;
  for (const s of [-1, 1]) {
    const g = new THREE.PlaneGeometry(panel, top - bottom, 8, 1);
    const p = g.getAttribute("position");
    // folds: the cloth waves toward and away from the wall
    for (let i = 0; i < p.count; i++) p.setZ(i, 0.03 * Math.sin((p.getX(i) / panel) * Math.PI * 4));
    g.computeVertexNormals();
    g.translate(f.u(w.along) + s * (w.w / 2 + panel / 2 - 0.08), (top + bottom) / 2, 0.08);
    parts.add(M.fabric(materials), tint(g.applyMatrix4(f.matrix), c));
  }
}

function sofa(materials: Materials, parts: Parts, c: THREE.Color) {
  parts.add(M.fabric(materials), tint(box(2.0, 0.42, 0.9).translate(0, 0.21, 0), c));
  parts.add(M.fabric(materials), tint(box(2.0, 0.45, 0.2).translate(0, 0.63, -0.35), c));
  for (const s of [-1, 1]) parts.add(M.fabric(materials), tint(box(0.2, 0.62, 0.9).translate(s * 0.9, 0.31, 0), c));
  const cushion = c.clone().offsetHSL(0, 0, 0.05);
  for (const x of [-0.53, 0, 0.53]) parts.add(M.fabric(materials), tint(box(0.52, 0.12, 0.66).translate(x, 0.48, 0.07), cushion));
}

function shelf(materials: Materials, parts: Parts, c: THREE.Color, r: seedrandom.PRNG) {
  const w = 1.0;
  const h = 1.9;
  const d = 0.32;
  for (const s of [-1, 1]) parts.add(M.wood(materials), tint(box(0.03, h, d).translate((s * (w - 0.03)) / 2, h / 2, 0), c));
  parts.add(M.wood(materials), tint(box(w, h, 0.01).translate(0, h / 2, -d / 2), c));
  for (let k = 0; k < 5; k++) {
    const y = 0.05 + k * 0.45;
    parts.add(M.wood(materials), tint(box(w - 0.06, 0.025, d).translate(0, y, 0), c));
    if (k === 4) continue;
    for (let x = -w / 2 + 0.05; x < w / 2 - 0.08;) {
      const t = 0.025 + 0.025 * r();
      const bh = 0.22 + 0.1 * r();
      parts.add(
        M.gloss(materials),
        tint(box(t, bh, 0.17 + 0.07 * r()).translate(x + t / 2, y + 0.0125 + bh / 2, 0.02), new THREE.Color().setHSL(r(), 0.2 + 0.3 * r(), 0.2 + 0.3 * r())),
      );
      x += t + 0.003;
    }
  }
}

function table(materials: Materials, parts: Parts, w: number, d: number, h: number, c: THREE.Color) {
  parts.add(M.wood(materials), tint(box(w, 0.035, d).translate(0, h - 0.0175, 0), c));
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      parts.add(M.wood(materials), tint(box(0.045, h - 0.035, 0.045).translate(sx * (w / 2 - 0.06), (h - 0.035) / 2, sz * (d / 2 - 0.06)), c));
}

function chair(materials: Materials, parts: Parts, c: THREE.Color) {
  parts.add(M.wood(materials), tint(box(0.42, 0.03, 0.42).translate(0, 0.45, 0), c));
  parts.add(M.wood(materials), tint(box(0.42, 0.45, 0.03).translate(0, 0.69, -0.2), c));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.add(M.wood(materials), tint(box(0.035, 0.45, 0.035).translate(sx * 0.18, 0.225, sz * 0.18), c));
}

function rug(materials: Materials, parts: Parts, w: number, d: number, c: THREE.Color) {
  if (w <= 0.5 || d <= 0.5) return;
  parts.add(M.fabric(materials), tint(box(w, 0.01, d).translate(0, 0.005, 0), c));
}

function counter(materials: Materials, parts: Parts, length: number, r: seedrandom.PRNG) {
  const front = new THREE.Color(pick(r, ["#e8e4dc", "#5b6b5e", "#2f3b4a", "#c9bfae"]));
  const top = new THREE.Color(pick(r, ["#3a3a38", "#d8d2c6", "#7a6a58"]));
  parts.add(M.gloss(materials), tint(box(length, 0.86, 0.58).translate(0, 0.43, 0), front));
  parts.add(M.gloss(materials), tint(box(length + 0.02, 0.04, 0.62).translate(0, 0.88, 0.01), top));
  parts.add(M.gloss(materials), tint(box(length, 0.7, 0.34).translate(0, 1.85, -0.12), front));
  // the joints between the fronts
  for (let x = -length / 2 + 0.6; x < length / 2; x += 0.6)
    parts.add(M.gloss(materials), tint(box(0.006, 0.8, 0.005).translate(x, 0.43, 0.29), new THREE.Color("#222222")));
}

function bed(materials: Materials, parts: Parts, cover: THREE.Color, frame: THREE.Color) {
  parts.add(M.wood(materials), tint(box(1.6, 0.3, 2.05).translate(0, 0.15, 0), frame));
  parts.add(M.wood(materials), tint(box(1.6, 0.95, 0.06).translate(0, 0.475, -1.0), frame));
  parts.add(M.fabric(materials), tint(box(1.5, 0.2, 1.95).translate(0, 0.4, 0.02), new THREE.Color("#efece4")));
  parts.add(M.fabric(materials), tint(box(1.54, 0.08, 1.45).translate(0, 0.53, 0.3), cover));
  for (const s of [-1, 1]) parts.add(M.fabric(materials), tint(box(0.6, 0.12, 0.38).translate(s * 0.36, 0.56, -0.72), new THREE.Color("#f4f2ec")));
}

function wardrobe(materials: Materials, parts: Parts, c: THREE.Color) {
  parts.add(M.wood(materials), tint(box(1.0, 2.0, 0.58).translate(0, 1.0, 0), c));
  parts.add(M.gloss(materials), tint(box(0.006, 1.9, 0.005).translate(0, 1.0, 0.29), new THREE.Color("#222222")));
  for (const s of [-1, 1]) parts.add(M.gloss(materials), tint(box(0.015, 0.18, 0.02).translate(s * 0.05, 1.05, 0.3), new THREE.Color("#a8a39a")));
}

/**
 * The stairwell's fittings: each flight with treads, risers, stringers and a handrail on
 * its open side; each landing a floor slab around the opening over the flight below,
 * guarded by a balustrade; a doormat at the front door; a loft ladder up to the hatch.
 */
function stairwell(materials: Materials, parts: Parts, room: Room, plan: FloorPlan, r: seedrandom.PRNG) {
  const b = room.box;
  const wood = new THREE.Color(pick(r, M.woodColors));
  const white = new THREE.Color("#f2efe8");
  skirting(materials, parts, b, r);
  for (const f of plan.flights) flight(materials, parts, b, f, wood, white);
  for (const { y, opening: o } of plan.landings) {
    // the slab around the opening: the hall's other band, and the band's ends beyond the opening
    const other = o.x0 > (b.x0 + b.x1) / 2 ? { x0: b.x0, x1: o.x0 } : { x0: o.x1, x1: b.x1 };
    const pieces = [
      { ...other, z0: b.z0, z1: b.z1 },
      { x0: o.x0, x1: o.x1, z0: o.z1, z1: b.z1 },
      { x0: o.x0, x1: o.x1, z0: b.z0, z1: o.z0 },
    ];
    for (const p of pieces)
      if (p.x1 - p.x0 > 0.01 && p.z1 - p.z0 > 0.01)
        parts.add(M.floorboards(materials), box(p.x1 - p.x0, SLAB, p.z1 - p.z0).translate((p.x0 + p.x1) / 2, y - SLAB / 2, (p.z0 + p.z1) / 2));
    // guard the opening's open long side
    const edge = o.x0 > (b.x0 + b.x1) / 2 ? o.x0 : o.x1;
    balustrade(materials, parts, new THREE.Vector3(edge, y, o.z0), new THREE.Vector3(edge, y, o.z1), wood, white);
  }
  const door = room.windows.find((w) => w.side === "front" && w.y <= b.y0 + 1e-6);
  if (door) parts.add(M.fabric(materials), tint(box(1.0, 0.012, 0.6).translate(door.along, b.y0 + 0.006, b.z1 - 0.45), new THREE.Color("#5a4a3a")));
  const hatch = room.hatch;
  if (hatch) {
    // a loft ladder from the top landing up through the hatch
    const floor = plan.landings[plan.landings.length - 1]?.y ?? b.y0;
    const x = (hatch.x0 + hatch.x1) / 2;
    const bottomZ = hatch.z0 - 0.7;
    const length = Math.hypot(b.y1 - floor, hatch.z0 + 0.1 - bottomZ);
    const tilt = Math.atan2(hatch.z0 + 0.1 - bottomZ, b.y1 - floor);
    const ladder = new THREE.Matrix4().makeTranslation(x, floor, bottomZ).multiply(new THREE.Matrix4().makeRotationX(tilt));
    for (const s of [-1, 1])
      parts.add(
        M.wood(materials),
        tint(
          box(0.05, length, 0.03)
            .translate((s * 0.4) / 2, length / 2, 0)
            .applyMatrix4(ladder),
          wood,
        ),
      );
    for (let v = 0.25; v < length; v += 0.28) parts.add(M.wood(materials), tint(box(0.4, 0.03, 0.03).translate(0, v, 0).applyMatrix4(ladder), wood));
  }
}

/** One straight flight: treads with nosings, risers, a stringer on each side, a handrail on the side open to the hall. */
function flight(materials: Materials, parts: Parts, b: Box, f: Flight, wood: THREE.Color, white: THREE.Color) {
  const rise = (f.y1 - f.y0) / f.steps;
  const dir = Math.sign(f.zEnd - f.zStart);
  const run = Math.abs(f.zEnd - f.zStart) / f.steps;
  const width = f.x1 - f.x0;
  const cx = (f.x0 + f.x1) / 2;
  for (let i = 0; i < f.steps - 1; i++) {
    const top = f.y0 + (i + 1) * rise;
    const z = f.zStart + dir * (i + 0.5) * run;
    parts.add(M.wood(materials), tint(box(width, 0.04, run + 0.03).translate(cx, top - 0.02, z - (dir * 0.03) / 2), wood));
    parts.add(M.gloss(materials), tint(box(width, rise - 0.04, 0.02).translate(cx, top - 0.04 - (rise - 0.04) / 2, f.zStart + dir * (i * run + 0.01)), white));
  }
  // stringers and handrail run along the slope
  const length = Math.hypot(f.y1 - f.y0, f.zEnd - f.zStart);
  const slope = Math.atan2(f.y1 - f.y0, Math.abs(f.zEnd - f.zStart));
  const along = (x: number, lift: number) =>
    new THREE.Matrix4().makeTranslation(x, (f.y0 + f.y1) / 2 + lift, (f.zStart + f.zEnd) / 2).multiply(new THREE.Matrix4().makeRotationX(dir * slope));
  for (const x of [f.x0 + 0.02, f.x1 - 0.02]) parts.add(M.gloss(materials), tint(box(0.04, 0.28, length).applyMatrix4(along(x, -0.1)), white));
  const open = f.x0 > (b.x0 + b.x1) / 2 ? f.x0 : f.x1;
  parts.add(M.wood(materials), tint(box(0.06, 0.05, length).applyMatrix4(along(open, 0.9)), wood));
  for (let i = 0; i < f.steps - 1; i += 1) {
    const top = f.y0 + (i + 1) * rise;
    const z = f.zStart + dir * (i + 0.5) * run;
    parts.add(M.gloss(materials), tint(box(0.03, 0.88, 0.03).translate(open, top + 0.44, z), white));
  }
}

/** A balustrade from `a` to `b` at floor height: posts at the ends, spindles and a rail. */
function balustrade(materials: Materials, parts: Parts, a: THREE.Vector3, b: THREE.Vector3, wood: THREE.Color, white: THREE.Color) {
  const length = a.distanceTo(b);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const along = Math.abs(b.z - a.z) > Math.abs(b.x - a.x);
  const rail = along ? box(0.06, 0.05, length) : box(length, 0.05, 0.06);
  parts.add(M.wood(materials), tint(rail.translate(mid.x, a.y + 0.92, mid.z), wood));
  for (const p of [a, b]) parts.add(M.wood(materials), tint(box(0.08, 0.95, 0.08).translate(p.x, a.y + 0.475, p.z), wood));
  const n = Math.floor(length / 0.12);
  for (let i = 1; i < n; i++) {
    const p = a.clone().lerp(b, i / n);
    parts.add(M.gloss(materials), tint(box(0.025, 0.9, 0.025).translate(p.x, a.y + 0.45, p.z), white));
  }
}

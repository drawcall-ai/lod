import type { Library } from "../materials.ts";
import * as THREE from "three/webgpu";
import { box, Parts, tint } from "../geometry.ts";
import { Random } from "../random.ts";
import { type Box, floorPlan, type Hole, type Room, type Side } from "./floorplan.ts";
import { furnish, wallFrame } from "./furniture.ts";
import * as M from "./furnishings.ts";
import type { HouseParams } from "./params.ts";

const SIDES: readonly Side[] = ["front", "back", "east", "west"];

/**
 * The rooms behind a house's windows (see `floorPlan`), from the same params as `house`:
 * one child per room whose geometry fills exactly its box — floor, ceiling and the inner
 * faces of its four walls facing in, with the outer windows and doors and the doorways
 * between rooms cut out — plus door casings, door leaves standing open or ajar, skirting,
 * a lamp, curtains and the furniture or stairs of its kind.
 */
export function houseInterior(library: Library, p: HouseParams): THREE.Group {
  const plan = floorPlan(p);
  const r = new Random(p.seed * 31 + 7);
  const group = new THREE.Group();
  group.name = "interior";
  for (const room of plan.rooms) group.add(roomGroup(library, room, plan, r));
  return group;
}

function roomGroup(library: Library, room: Room, plan: ReturnType<typeof floorPlan>, r: Random): THREE.Group {
  const parts = new Parts();
  const b = room.box;
  const paint = new THREE.Color(room.kind === "stairwell" ? "#ece8df" : r.pick(M.wallColors));
  for (const side of SIDES)
    parts.add(
      M.plaster(library),
      tint(
        wallFace(
          b,
          side,
          [...room.windows, ...room.doors].filter((h) => h.side === side),
        ),
        paint,
      ),
    );
  const hatch = room.hatch;
  parts.add(room.kind === "kitchen" || room.kind === "bath" ? M.tiles(library) : M.floorboards(library), slab(b, false, hatch?.in === "floor" ? hatch : null));
  parts.add(M.ceiling(library), slab(b, true, hatch?.in === "ceiling" ? hatch : null));
  for (const door of room.doors) doorway(library, parts, b, door, r);
  furnish(library, parts, room, plan, r);
  const group = parts.build(room.kind);
  // the house's walls shade the rooms; the rooms need not shade anything
  for (const mesh of group.children) mesh.castShadow = false;
  return group;
}

/** The inner face of one wall of the box, facing into the room, with `holes` cut out; UVs in metres. */
function wallFace(b: Box, side: Side, holes: Hole[]): THREE.BufferGeometry {
  const f = wallFrame(b, side);
  const height = b.y1 - b.y0;
  const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(f.length, 0), new THREE.Vector2(f.length, height), new THREE.Vector2(0, height)]);
  for (const o of holes) {
    const u = f.u(o.along);
    const y0 = Math.max(o.y - b.y0, 0.001);
    const y1 = Math.min(o.y + o.h - b.y0, height - 0.001);
    shape.holes.push(
      new THREE.Path([
        new THREE.Vector2(u - o.w / 2, y0),
        new THREE.Vector2(u + o.w / 2, y0),
        new THREE.Vector2(u + o.w / 2, y1),
        new THREE.Vector2(u - o.w / 2, y1),
      ]),
    );
  }
  return new THREE.ShapeGeometry(shape).applyMatrix4(f.matrix);
}

/** The floor (facing up) or ceiling (facing down) of the box, with a hatch cut out; UVs in metres. */
function slab(b: Box, ceiling: boolean, hatch: { x0: number; x1: number; z0: number; z1: number } | null): THREE.BufferGeometry {
  // shape space (x, ±z), turned so the shape's +z, the face's normal, points up (floor) or down (ceiling)
  const s = ceiling ? 1 : -1;
  const rect = (x0: number, x1: number, z0: number, z1: number) => [
    new THREE.Vector2(x0, s * z0),
    new THREE.Vector2(x1, s * z0),
    new THREE.Vector2(x1, s * z1),
    new THREE.Vector2(x0, s * z1),
  ];
  const shape = new THREE.Shape(rect(b.x0, b.x1, b.z0, b.z1));
  if (hatch) shape.holes.push(new THREE.Path(rect(hatch.x0, hatch.x1, hatch.z0, hatch.z1)));
  return new THREE.ShapeGeometry(shape).rotateX((s * Math.PI) / 2).translate(0, ceiling ? b.y1 : b.y0, 0);
}

/** Casing around a doorway on this room's side, and the leaf if this room hangs it, swung into the room. */
function doorway(library: Library, parts: Parts, b: Box, door: Room["doors"][number], r: Random) {
  const f = wallFrame(b, door.side);
  const u = f.u(door.along);
  const y = door.y - b.y0;
  const at = (g: THREE.BufferGeometry) => g.applyMatrix4(f.matrix);
  const trim = new THREE.Color("#f3f0e8");
  const c = 0.07;
  for (const s of [-1, 1])
    parts.add(M.gloss(library), tint(at(box(c, door.h + c, 0.018).translate(u + s * (door.w / 2 + c / 2), y + (door.h + c) / 2, 0.009)), trim));
  parts.add(M.gloss(library), tint(at(box(door.w + 2 * c, c, 0.018).translate(u, y + door.h + c / 2, 0.009)), trim));
  if (door.leaf === null) return;
  const leaf = new THREE.Color(r.chance(0.7) ? "#f1eee6" : "#8a6446");
  const width = door.w - 0.02;
  const hinge = new THREE.Matrix4().makeTranslation(u - door.w / 2 + 0.01, y, 0.03).multiply(new THREE.Matrix4().makeRotationY(-door.leaf));
  const place = (g: THREE.BufferGeometry) => at(g.applyMatrix4(hinge));
  parts.add(M.gloss(library), tint(place(box(width, door.h - 0.01, 0.04).translate(width / 2, (door.h - 0.01) / 2, 0)), leaf));
  parts.add(M.gloss(library), tint(place(box(0.12, 0.02, 0.06).translate(width - 0.1, 1.0, 0)), new THREE.Color("#b5ada0")));
}

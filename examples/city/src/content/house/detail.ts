import * as THREE from "three/webgpu";
import { box, Parts } from "../geometry.ts";
import { surface } from "../materials.ts";
import { Random } from "../random.ts";
import * as M from "./materials.ts";
import { type Dressing, doorUnit, windowUnit } from "./openings.ts";
import { type Facade, facades } from "./facades.ts";
import { heights, type HouseParams, wallThickness as t } from "./params.ts";
import { roof } from "./roof.ts";
import { wallSlab } from "./wall.ts";

/** The full-detail house: walls with openings, joinery, glass, roof, gutters, chimney. */
export function detail(p: HouseParams): THREE.Group {
  const r = new Random(p.seed);
  const parts = new Parts();
  for (const f of facades(p)) facade(parts.at(f.frame), f, p, r);
  roof(parts, p);
  // gravel drip strip along the base, where rain from the eaves lands
  const gravel = surface("gravel_road", { normalScale: 1.5, weather: 0.3 });
  const strip = 0.4;
  for (const z of [-1, 1]) parts.add(gravel, box(p.width + 2 * strip, 0.03, strip).translate(0, 0.015, z * (p.depth / 2 + strip / 2)));
  for (const x of [-1, 1]) parts.add(gravel, box(strip, 0.03, p.depth).translate(x * (p.width / 2 + strip / 2), 0.015, 0));
  const house = parts.build("house");
  // sunlight falls through the windows into the rooms
  for (const mesh of house.children) if (mesh instanceof THREE.Mesh && mesh.material === M.glass()) mesh.castShadow = false;
  return house;
}

function facade(parts: Parts, f: Facade, p: HouseParams, r: Random) {
  const { eave, ridge } = heights(p);
  const half = f.length / 2;
  const outline = f.gable
    ? [new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(half, eave), new THREE.Vector2(0, ridge), new THREE.Vector2(-half, eave)]
    : [new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(half, eave), new THREE.Vector2(-half, eave)];

  const { windows, door } = f;
  const wall = M.wall(p);
  parts.add(wall, wallSlab(outline, door ? [...windows, door] : windows, t));

  const dressing: Dressing = {
    frame: M.paint(p.trim),
    sill: M.concrete(),
    surround: p.wall.kind === "stucco" ? wall : null,
    lintel: p.wall.kind === "brick" ? M.brick() : null,
    shutters: p.shutters ? M.paint(p.shutters) : null,
  };
  for (const o of windows) windowUnit(parts, o, { ...dressing, shutters: o.y > eave ? null : dressing.shutters }, r);
  if (door) doorUnit(parts, door, M.paint(p.trim), M.paint(p.door), M.concrete(), t);

  // plinth band, interrupted by the door and its steps
  // long facades stop at the gable walls' inner faces, so their bands reach over the corners
  const reach = half + (f.gable ? 0.025 : t + 0.025);
  const spans = door
    ? [
        [-reach, door.x - door.w / 2 - 0.05],
        [door.x + door.w / 2 + 0.05, reach],
      ]
    : [[-reach, reach]];
  for (const [a = 0, b = 0] of spans) parts.add(M.plinth(), box(b - a, p.plinth, 0.05).translate((a + b) / 2, p.plinth / 2, 0));

  if (p.wall.kind === "stucco") {
    for (let floor = 1; floor < p.floors; floor++) {
      const y = p.plinth + floor * p.floorHeight - 0.12;
      parts.add(wall, box(2 * reach + 0.01, 0.16, 0.03).translate(0, y, 0.015));
    }
  }
}

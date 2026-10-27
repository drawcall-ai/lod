import * as THREE from "three/webgpu";
import { box, Parts } from "./geometry.ts";
import { house, houseInterior, houseParams, type HouseParams } from "./house/index.ts";
import * as M from "./house/materials.ts";
import { surface } from "./materials.ts";

/**
 * The town church: a tall brick hall built like the houses (the same walls, windows,
 * roof and rooms behind the glass, from its own params), with a square tower at its
 * east gable and a slate spire. Returns the parts the levels need: the detailed church
 * with its tower, its rooms, and a low shell for baking.
 */
export function church(): { detail: THREE.Group; interior: THREE.Group; low: THREE.Mesh; params: HouseParams } {
  const params: HouseParams = {
    ...houseParams(3),
    width: 19,
    depth: 10,
    floors: 2,
    floorHeight: 4.2,
    plinth: 0.5,
    wall: { kind: "brick", color: "#ffffff" },
    roof: { tiles: "slate", color: "#3d4146", pitch: 52, overhang: 0.5 },
    trim: "#efece4",
    door: "#4a2a1e",
    shutters: null,
    chimney: null,
    columns: 5,
    sideColumns: 2,
    seed: 99,
  };
  const built = house(params);
  const tower = new Parts();
  const stone = surface("red_brick", { weather: 0.9 });
  const slate = surface("white_stucco", { color: "#3a3e44", normalScale: 1.2, weather: 0.5 });
  const size = 4.6;
  const height = 21;
  const x = params.width / 2 + size / 2 - 0.2;
  tower.add(stone, box(size, height, size).translate(x, height / 2, 0));
  // belfry openings: louvred and dark, on all four sides
  for (const [dx, dz, rot] of [
    [size / 2, 0, Math.PI / 2],
    [-size / 2, 0, Math.PI / 2],
    [0, size / 2, 0],
    [0, -size / 2, 0],
  ] as const)
    tower.add(
      M.paint("#1e1f1f"),
      box(1.2, 2.4, 0.08)
        .rotateY(rot)
        .translate(x + dx, height - 3, dz),
    );
  tower.add(stone, box(size + 0.3, 0.4, size + 0.3).translate(x, height + 0.2, 0));
  tower.add(slate, new THREE.ConeGeometry(size * 0.72, 11, 4, 1).rotateY(Math.PI / 4).translate(x, height + 0.4 + 5.5, 0));
  tower.add(M.zinc(), new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6).translate(x, height + 0.4 + 11.8, 0));
  const detail = built.detail;
  detail.add(tower.build("tower"));
  // the low shell gets the tower too: a box under a pyramid
  const towerLow = new THREE.BoxGeometry(size, height, size).translate(x, height / 2, 0);
  const spireLow = new THREE.ConeGeometry(size * 0.72, 11, 4, 1)
    .rotateY(Math.PI / 4)
    .translate(x, height + 0.4 + 5.5, 0)
    .toNonIndexed();
  const low = built.low;
  low.geometry = mergeShell(low.geometry, [towerLow.toNonIndexed(), spireLow]);
  return { detail, interior: houseInterior(params), low, params };
}

/** The low shell with more closed parts added (positions and normals only: the bake unwraps it again). */
function mergeShell(shell: THREE.BufferGeometry, extra: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = [shell, ...extra].map((g) => {
    const plain = new THREE.BufferGeometry();
    const flat = g.index ? g.toNonIndexed() : g;
    plain.setAttribute("position", flat.getAttribute("position"));
    plain.computeVertexNormals();
    return plain;
  });
  const position = parts.flatMap((g) => Array.from(g.getAttribute("position").array));
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  merged.computeVertexNormals();
  return merged;
}

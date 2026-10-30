import type { Library } from "../materials.ts";
import * as THREE from "three/webgpu";
import { box, Parts } from "../geometry.ts";
import type { HouseParams } from "./params.ts";
import { detail as houseDetail } from "./detail.ts";
import { low as houseLow } from "./low.ts";
import * as M from "./materials.ts";

export function churchParams(): HouseParams {
  return {
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
}

/**
 * The bell tower against the hall's +x gable: its shaft and the spire on top. Both church
 * levels build it here, so the low shell the bake projects onto matches the source.
 */
function tower(params: HouseParams) {
  const size = 4.6;
  const height = 21;
  const x = params.width / 2 + size / 2 - 0.2;
  const shaft = box(size, height, size).translate(x, height / 2, 0);
  const spire = new THREE.ConeGeometry(size * 0.72, 11, 4, 1).rotateY(Math.PI / 4).translate(x, height + 0.4 + 5.5, 0);
  return { size, height, x, shaft, spire };
}

/** Brick hall with a bell tower and slate spire. */
export function churchDetail(library: Library, params: HouseParams): THREE.Group {
  const parts = new Parts();
  const stone = M.churchStone(library);
  const { size, height, x, shaft, spire } = tower(params);
  parts.add(stone, shaft);
  // belfry openings: louvred and dark, on all four sides
  for (const [dx, dz, rot] of [
    [size / 2, 0, Math.PI / 2],
    [-size / 2, 0, Math.PI / 2],
    [0, size / 2, 0],
    [0, -size / 2, 0],
  ] as const)
    parts.add(
      M.paint(library, "#1e1f1f"),
      box(1.2, 2.4, 0.08)
        .rotateY(rot)
        .translate(x + dx, height - 3, dz),
    );
  parts.add(stone, box(size + 0.3, 0.4, size + 0.3).translate(x, height + 0.2, 0));
  parts.add(M.churchSlate(library), spire);
  parts.add(M.zinc(library), new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6).translate(x, height + 0.4 + 11.8, 0));
  const detail = houseDetail(library, params);
  detail.add(parts.build("tower"));
  return detail;
}

/** The house's low shell with the tower's shaft and spire added. */
export function churchLow(params: HouseParams): THREE.Mesh {
  const { shaft, spire } = tower(params);
  const low = houseLow(params);
  low.geometry = mergeShell(low.geometry, [shaft, spire]);
  return low;
}

/** The low shell with more closed parts added (positions and normals only: the bake unwraps it again). */
function mergeShell(shell: THREE.BufferGeometry, extra: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const position = [shell, ...extra].flatMap((g) => Array.from((g.index ? g.toNonIndexed() : g).getAttribute("position").array));
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  merged.computeVertexNormals();
  return merged;
}

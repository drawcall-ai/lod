import * as THREE from "three/webgpu";
import { pose } from "../geometry.ts";
import { heights, type HouseParams, wallThickness as t } from "./params.ts";
import type { Opening } from "./wall.ts";

/** One outer wall: where it stands and where its windows and door are. */
export interface Facade {
  /** Pose of the wall frame: x along the wall, outer face at z = 0 facing outward. */
  frame: THREE.Matrix4;
  length: number;
  gable: boolean;
  /** Windows in the wall frame; the gable's attic window included. */
  windows: Opening[];
  door: Opening | null;
}

/**
 * The four outer walls of a house and their openings: the front (+z, with the door) and
 * back long facades between the gables, and the two gables (±x). Windows stand in
 * `columns` evenly spaced columns, one per floor, the door in the middle column of the
 * front's ground floor; the exterior and the rooms behind both follow this layout.
 */
export function facades(p: HouseParams): Facade[] {
  const { eave, ridge } = heights(p);
  const walls = [
    { frame: pose(0, 0, p.depth / 2), length: p.width - 2 * t, gable: false, columns: p.columns, door: true },
    { frame: pose(0, 0, -p.depth / 2, Math.PI), length: p.width - 2 * t, gable: false, columns: p.columns, door: false },
    { frame: pose(p.width / 2, 0, 0, Math.PI / 2), length: p.depth, gable: true, columns: p.sideColumns, door: false },
    { frame: pose(-p.width / 2, 0, 0, -Math.PI / 2), length: p.depth, gable: true, columns: p.sideColumns, door: false },
  ];
  return walls.map((f) => {
    const half = f.length / 2;
    const windows: Opening[] = [];
    let door: Opening | null = null;
    const spacing = (f.length - (f.gable ? 0.6 : 0)) / f.columns;
    const doorColumn = Math.floor(f.columns / 2);
    for (let c = 0; c < f.columns; c++) {
      const x = -half + (f.gable ? 0.3 : 0) + spacing * (c + 0.5);
      for (let floor = 0; floor < p.floors; floor++) {
        const level = p.plinth + floor * p.floorHeight;
        if (f.door && floor === 0 && c === doorColumn) {
          door = { x, y: p.plinth, w: 1.05, h: 2.2 };
          continue;
        }
        windows.push({ x, y: level + 0.85, w: p.wall.kind === "stucco" ? 1.1 : 1.0, h: Math.min(1.45, p.floorHeight - 1.3) });
      }
    }
    if (f.gable && ridge - eave > 2.4) windows.push({ x: 0, y: eave + 0.35, w: 0.75, h: 0.95 });
    return { frame: f.frame, length: f.length, gable: f.gable, windows, door };
  });
}

/** The x of each column boundary along the long facades (from the inner face of one gable wall to the other's). */
export function columnBounds(p: HouseParams): number[] {
  const half = (p.width - 2 * t) / 2;
  return Array.from({ length: p.columns + 1 }, (_, k) => -half + ((2 * half) / p.columns) * k);
}

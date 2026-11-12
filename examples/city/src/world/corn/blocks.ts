import * as THREE from "three/webgpu";
import type { Lod } from "@drawcall/lod";
import { levelBox } from "../bounds.ts";
import type { Copy, Scatter } from "../scatter.ts";
import { type Tile, vigour } from "./field.ts";
import { DESIGNS } from "../../../public/corn/layout.ts";
import type { Wall } from "../../../public/corn/block/model.ts";

const YELLOWER = new THREE.Color(1.05, 1, 0.85);

/**
 * The blocks of a design, or a field's outer walls along x or z, as public/corn/index.glts draws them: after an empty
 * level 0, a canopy rises out of the soil near, then is ridged, then flat far away; a wall only rises.
 */
export interface Block {
  kind: "canopy" | "wall";
  lod: Lod;
  /** The distances (m) from the camera over which the block rises out of the soil: sunk nearer than x, whole from y on. */
  rises: THREE.Vector2;
  /** Of the block's ridged canopy, or its wall. */
  diameter: number;
}

/** Every block design's canopies over `tiles`, then the walls along x and z, in `scatter`. */
export async function blocks(tiles: Tile[], scatter: Scatter): Promise<Block[]> {
  const canopies = Array.from({ length: DESIGNS }, (_, design) =>
    block(
      scatter,
      "canopy",
      `/corn/index.glts?block=${design}`,
      tiles.filter((tile) => tile.design === design).map((tile) => ({ matrix: tile.matrix, color: tint(tile.centre) })),
    ),
  );
  const walls = (["x", "z"] as const).map((wall) => block(scatter, "wall", `/corn/index.glts?block=${wall}`, wallCopies(tiles, wall)));
  return Promise.all([...canopies, ...walls]);
}

/** `copies` of the block asset at `url`. */
async function block(scatter: Scatter, kind: Block["kind"], url: string, copies: Copy[]): Promise<Block> {
  const [lod] = await Promise.all([scatter.lod(url), scatter.place(url, copies)]);
  const measured = lod.levels[kind === "canopy" ? 2 : 1];
  if (!measured) throw new Error(`${url} has no ${kind} level`);
  const rises: unknown = lod.userData.rises;
  if (!(rises instanceof THREE.Vector2)) throw new Error(`${url} has no userData.rises to rise by`);
  return { kind, lod, rises, diameter: levelBox(measured).getSize(new THREE.Vector3()).length() };
}

/** The walls along `wall` of the tiles on a field's boundary: on a block's +side, or turned half round its -side. */
function wallCopies(tiles: Tile[], wall: Wall): Copy[] {
  const turn = new THREE.Matrix4().makeRotationY(Math.PI);
  return tiles.flatMap((tile) =>
    tile.walls
      .filter((tileWall) => tileWall.wall === wall)
      .map((tileWall) => ({ matrix: tileWall.turned ? tile.matrix.clone().multiply(turn) : tile.matrix, color: tint(tile.centre) })),
  );
}

/**
 * A block's tint at `at`: fields vary in vigour over tens of metres, a little lighter,
 * darker, yellower.
 */
function tint(at: THREE.Vector3): THREE.Color {
  return new THREE.Color(1, 1, 1).multiplyScalar(0.96 + 0.08 * vigour(at)).lerp(YELLOWER, 0.25 * vigour(at.clone().multiplyScalar(1.7)));
}

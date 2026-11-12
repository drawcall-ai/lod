import * as THREE from "three/webgpu";
import type { LodCluster } from "@drawcall/lod";

/** A tile near the camera, by id, and its distance from it. */
export interface NearTile {
  tile: number;
  distance: number;
}

/** A cluster a tile adds to `clusters`, those of the instances it is written into. */
export interface TileCluster {
  clusters: LodCluster[];
  cluster: LodCluster;
}

export interface NearTilesOptions {
  /** The tiles to hold for a camera at `eye`, nearest first. */
  near: (eye: THREE.Vector3) => NearTile[];
  /** Writes `tile`'s instances into slot `slot` (below `room`) and gives the clusters that draw them. */
  fill: (tile: number, slot: number) => TileCluster[];
  /** The most tiles filled in one update. */
  perFrame: number;
  /** The most tiles held at once, the nearest, each in a slot of its own. */
  room: number;
}

/**
 * Instances that exist only near the camera, in tiles: a field or a forest holds far too many to draw everywhere. Each
 * held tile has a slot of `room`, which its instances are written into and its clusters draw. Each update lets go of
 * the tiles out of reach and fills up to `perFrame` of the nearest `room` not yet held, the nearest first. A tile in
 * reach but past the nearest `room` stays until a nearer one takes its slot, the farthest first, so a field shows no
 * holes while its replacements fill a few per frame. The instances are written on the CPU (corn plants, see
 * corn/field.ts) or by a compute pass (forests and ground cover, see planting.ts).
 */
export class NearTiles extends THREE.Group {
  /** Tiles near in the last update, held or not, past `room` too. */
  wanted = 0;
  /** Per tile held, its slot and the clusters it added. */
  private readonly held = new Map<number, { slot: number; clusters: TileCluster[] }>();
  /** The slots no tile holds, the lowest last. */
  private readonly free: number[];
  /** The tiles to hold, nearest first. */
  private nearest = new Set<number>();

  constructor(private readonly options: NearTilesOptions) {
    super();
    this.free = Array.from({ length: options.room }, (_, i) => options.room - 1 - i);
  }

  /** Whether every tile to hold is held: diagnostics wait for it without passing the budget per frame. */
  get settled(): boolean {
    if (this.held.size !== this.nearest.size) return false;
    for (const tile of this.nearest) if (!this.held.has(tile)) return false;
    return true;
  }

  /** Call once before rendering a frame, with the camera's position. */
  update(eye: THREE.Vector3): void {
    const { near, fill, perFrame, room } = this.options;
    const tiles = near(eye);
    this.wanted = tiles.length;
    this.nearest = new Set(tiles.slice(0, room).map(({ tile }) => tile));
    const reach = new Set(tiles.map(({ tile }) => tile));
    for (const tile of this.held.keys()) if (!reach.has(tile)) this.release(tile);
    // held past the nearest `room`, nearest first: the last gives its slot first
    const spare = tiles.filter(({ tile }) => this.held.has(tile) && !this.nearest.has(tile));
    let filled = 0;
    for (const tile of this.nearest) {
      if (filled === perFrame) return;
      if (this.held.has(tile)) continue;
      if (this.free.length === 0) {
        const farthest = spare.pop();
        if (!farthest) throw new Error(`NearTiles: ${this.held.size} tiles held, but none past the nearest ${room}`);
        this.release(farthest.tile);
      }
      const slot = this.free.pop();
      if (slot === undefined) throw new Error("NearTiles: a release freed no slot");
      const clusters = fill(tile, slot);
      for (const { clusters: into, cluster } of clusters) into.push(cluster);
      this.held.set(tile, { slot, clusters });
      filled++;
    }
  }

  private release(tile: number): void {
    const held = this.held.get(tile);
    if (!held) throw new Error(`NearTiles: tile ${tile} is not held`);
    this.held.delete(tile);
    this.free.push(held.slot);
    for (const { clusters, cluster } of held.clusters) {
      const index = clusters.indexOf(cluster);
      if (index < 0) throw new Error(`NearTiles: a cluster of tile ${tile} is gone`);
      clusters.splice(index, 1);
    }
  }
}

/** A square grid tile's id from its coordinates (each within ±32768), and back. */
export const tileKey = (i: number, j: number): number => (i + 32768) * 65536 + j + 32768;
export const tileAt = (key: number): [i: number, j: number] => [Math.floor(key / 65536) - 32768, (key % 65536) - 32768];

/**
 * The tiles of a square grid, `tile` metres on edge, within `radius` of a camera at `eye` standing `above` the ground,
 * nearest first, measured to each tile's nearest point on the ground; `holds` leaves out tiles with nothing in them.
 */
export function tilesAround(
  eye: THREE.Vector3,
  above: number,
  { radius, tile, holds }: { radius: number; tile: number; holds: (key: number) => boolean },
): NearTile[] {
  if (above > radius) return [];
  const flat = Math.sqrt(radius ** 2 - above ** 2);
  const tiles: NearTile[] = [];
  for (let j = Math.floor((eye.z - flat) / tile); j <= Math.floor((eye.z + flat) / tile); j++)
    for (let i = Math.floor((eye.x - flat) / tile); i <= Math.floor((eye.x + flat) / tile); i++) {
      const key = tileKey(i, j);
      if (!holds(key)) continue;
      const distance = Math.hypot(
        Math.max(Math.abs(eye.x - (i + 0.5) * tile) - tile / 2, 0),
        Math.max(Math.abs(eye.z - (j + 0.5) * tile) - tile / 2, 0),
        above,
      );
      if (distance <= radius) tiles.push({ tile: key, distance });
    }
  return tiles.sort((a, b) => a.distance - b.distance);
}

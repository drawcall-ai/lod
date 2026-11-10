import * as THREE from "three/webgpu";
import type { InstancedLod, InstancedLodChunkParameters } from "@drawcall/lod";

/** A tile near the camera, by id, and its distance from it. */
export interface NearTile {
  tile: number;
  distance: number;
}

/** What tiles add chunks to: an InstancedLod, or anything holding chunks as one does. */
export type ChunkHolder = THREE.Object3D & {
  addChunk(parameters: InstancedLodChunkParameters): unknown;
  removeChunk(chunk: unknown): void;
};

/** The chunk a tile adds to one InstancedLod. */
export interface TileChunk<L extends ChunkHolder = InstancedLod> {
  lod: L;
  parameters: InstancedLodChunkParameters;
}

export interface NearTilesOptions<L extends ChunkHolder = InstancedLod> {
  /** The tiles to hold for a camera at `eye`, nearest first. */
  near: (eye: THREE.Vector3) => NearTile[];
  /** Fills `tile`, the `slot`th filled in this update (below `perFrame`), and gives its chunks. */
  chunks: (tile: number, slot: number) => TileChunk<L>[];
  /** The most tiles filled in one update. */
  perFrame: number;
  /** The most tiles held at once, the nearest (default: every near tile). */
  room?: number;
}

/**
 * Instances that exist only near the camera, in tiles: a field or a forest holds far too many for one instance list.
 * Each update lets go of the tiles out of reach and fills up to `perFrame` of the nearest `room` not yet held, the
 * nearest first; each tile filled adds a chunk to the InstancedLods it has instances for. A tile in reach but past the
 * nearest `room` stays until a nearer one fills in its place, the farthest first, so a field shows no holes while its
 * replacements fill a few per frame. The chunks come from the CPU (corn plants, see corn/field.ts) or from a compute pass
 * (forests and ground cover, see planting.ts).
 */
export class NearTiles<L extends ChunkHolder = InstancedLod> extends THREE.Group {
  /** Tiles near in the last update, held or not, past `room` too. */
  wanted = 0;
  /** Per tile held, its chunk in each InstancedLod it fills. */
  private readonly held = new Map<number, { lod: L; chunk: unknown }[]>();
  /** The tiles to hold, nearest first. */
  private nearest = new Set<number>();

  constructor(
    readonly lods: L[],
    private readonly options: NearTilesOptions<L>,
  ) {
    super();
    this.add(...lods);
  }

  /** Whether every tile to hold is held: diagnostics wait for it without passing the budget per frame. */
  get settled(): boolean {
    if (this.held.size !== this.nearest.size) return false;
    for (const tile of this.nearest) if (!this.held.has(tile)) return false;
    return true;
  }

  /** Call once before rendering a frame, with the camera's position. */
  update(eye: THREE.Vector3): void {
    const { near, chunks, perFrame, room = Infinity } = this.options;
    const tiles = near(eye);
    this.wanted = tiles.length;
    this.nearest = new Set(tiles.slice(0, room).map(({ tile }) => tile));
    const reach = new Set(tiles.map(({ tile }) => tile));
    for (const tile of this.held.keys()) if (!reach.has(tile)) this.release(tile);
    // held past the nearest `room`, nearest first: the last gives its room first
    const spare = tiles.filter(({ tile }) => this.held.has(tile) && !this.nearest.has(tile));
    let slot = 0;
    for (const tile of this.nearest) {
      if (slot === perFrame) return;
      if (this.held.has(tile)) continue;
      if (this.held.size >= room) {
        const farthest = spare.pop();
        if (!farthest) throw new Error(`NearTiles: ${this.held.size} tiles held, but none past the nearest ${room}`);
        this.release(farthest.tile);
      }
      this.held.set(
        tile,
        chunks(tile, slot++).map(({ lod, parameters }) => ({ lod, chunk: lod.addChunk(parameters) })),
      );
    }
  }

  private release(tile: number): void {
    const chunks = this.held.get(tile);
    if (!chunks) throw new Error(`NearTiles: tile ${tile} is not held`);
    this.held.delete(tile);
    for (const { lod, chunk } of chunks) lod.removeChunk(chunk);
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

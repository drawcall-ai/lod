import * as THREE from "three/webgpu";
import type { GpuChunk, InstancedLod } from "@drawcall/lod";

/** Tiles a stream takes in per frame, each through one slot of its ring of records. */
export const SLOTS = 4;

/** A tile's id from its grid coordinates (each within ±32768). */
export const tileKey = (i: number, j: number): number => (i + 32768) * 65536 + j + 32768;

/** What a stream asks of a crowd. */
export type Crowd = THREE.Object3D & Pick<InstancedLod, "addGpuChunk" | "removeGpuChunk">;

export interface StreamOptions {
  /** How far from the camera tiles are held (m). */
  radius: number;
  /** Edge of a tile (m). */
  tile: number;
  /** Records per slot. */
  capacity: number;
  /** Whether anything grows on a tile: others are never taken in. */
  holds: (key: number) => boolean;
  /** The ground's height range over a tile from its least corner, for the box around its copies. */
  heightsOver: (x0: number, z0: number) => [low: number, high: number];
  /** Writes a tile's records into a slot of the ring, on the GPU. */
  emit: (i: number, j: number, slot: number) => void;
}

interface Near {
  i: number;
  j: number;
  distance: number;
}

/**
 * Instances that come out of a compute pass as the camera moves: every tile within `radius` is a GPU chunk in each
 * crowd, written through a small ring of slots. A slot is free again once a frame has rendered, so a frame takes in as
 * many tiles as there are slots, the nearest first, and nothing ever travels back to the CPU. The crowds' loading items
 * stay held until the GPU has taken the chunks in.
 */
export class Stream extends THREE.Group {
  private readonly held = new Map<number, { crowd: Crowd; chunk: GpuChunk }[]>();

  constructor(
    private readonly crowds: Crowd[],
    private readonly options: StreamOptions,
  ) {
    super();
    this.add(...crowds);
  }

  /** Call once before rendering a frame, with the camera's position and its height above the ground. */
  update(eye: THREE.Vector3, above: number): void {
    const near = this.near(eye, above);
    const wanted = new Set(near.map(({ i, j }) => tileKey(i, j)));
    // Far tiles go first, so their pages are free for the near ones.
    for (const key of this.held.keys()) if (!wanted.has(key)) this.release(key);
    let slot = 0;
    for (const tile of near) {
      if (slot === SLOTS) return;
      if (!this.held.has(tileKey(tile.i, tile.j))) this.take(tile, slot++);
    }
  }

  private near(eye: THREE.Vector3, above: number): Near[] {
    const { radius, tile, holds } = this.options;
    if (above > radius) return [];
    const flat = Math.sqrt(radius ** 2 - above ** 2);
    const tiles: Near[] = [];
    for (let j = Math.floor((eye.z - flat) / tile); j <= Math.floor((eye.z + flat) / tile); j++)
      for (let i = Math.floor((eye.x - flat) / tile); i <= Math.floor((eye.x + flat) / tile); i++) {
        if (!holds(tileKey(i, j))) continue;
        // to the tile's nearest point, so a tile under the camera counts as at hand
        const distance = Math.hypot(Math.max(Math.abs(eye.x - (i + 0.5) * tile) - tile / 2, 0), Math.max(Math.abs(eye.z - (j + 0.5) * tile) - tile / 2, 0), above);
        if (distance <= radius) tiles.push({ i, j, distance });
      }
    return tiles.sort((a, b) => a.distance - b.distance);
  }

  private take({ i, j }: Near, slot: number): void {
    const { tile, capacity, heightsOver, emit } = this.options;
    emit(i, j, slot);
    const [low, high] = heightsOver(i * tile, j * tile);
    const box = new THREE.Box3(new THREE.Vector3(i * tile, low, j * tile), new THREE.Vector3((i + 1) * tile, high, (j + 1) * tile));
    this.held.set(
      tileKey(i, j),
      this.crowds.map((crowd) => ({ crowd, chunk: crowd.addGpuChunk({ box, first: slot * capacity, counter: slot }) })),
    );
  }

  private release(key: number): void {
    for (const { crowd, chunk } of this.held.get(key) ?? []) crowd.removeGpuChunk(chunk);
    this.held.delete(key);
  }
}

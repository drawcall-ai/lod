import * as THREE from "three/webgpu";
import type { InstancedChunk, InstancedLod } from "@drawcall/lod";

/** Where patches come from: tiles of ground, each holding instances of the InstancedLods. */
export interface Tiles {
  /** Tiles within `reach` metres of `eye`, by id, with their distance. */
  near(eye: THREE.Vector3, reach: number, visit: (tile: number, distance: number) => void): void;
  /** Writes the tile's instances: which InstancedLod (index) and its instance matrix. */
  fill(tile: number, emit: (lod: number, matrix: THREE.Matrix4) => void): void;
}

const eye = new THREE.Vector3();

/**
 * Instances placed on the CPU that exist only near the camera: corn plants in the blocks
 * close enough to show them. A field holds millions of plants, far too many for one
 * instance list; here the nearest `room` tiles within `reach` (re-measured each frame)
 * each add a chunk of their instances to every InstancedLod, one tile a frame, and remove
 * it when the camera moves on. Ground cover comes from the GPU instead: see `Stream`.
 */
export class Patches extends THREE.Object3D {
  /** View height in CSS pixels that reaches are measured on, as the package measures levels; the app sets it. */
  static height = 1080;
  /** Tiles that wanted a chunk in the last update, filled or not. */
  wanted = 0;
  /** Tiles filled now, and the chunk each added to each InstancedLod. */
  private readonly held = new Map<number, { lod: InstancedLod; chunk: InstancedChunk }[]>();
  /** Each InstancedLod, and the matrices of the tile being filled for it. */
  private readonly filling: { lod: InstancedLod; matrices: number[] }[];
  private readonly candidates: { tile: number; distance: number }[] = [];
  private readonly records: { tile: number; distance: number }[] = [];
  private readonly keep = new Set<number>();
  private readonly emit = (l: number, matrix: THREE.Matrix4): void => {
    const filling = this.filling[l];
    if (!filling) throw new Error(`Patches: a tile emits for InstancedLod ${l}, which it does not have`);
    filling.matrices.push(...matrix.elements);
  };
  private readonly collect = (tile: number, distance: number): void => {
    const index = this.candidates.length;
    const record = this.records[index] ?? { tile, distance };
    record.tile = tile;
    record.distance = distance;
    this.records[index] = record;
    this.candidates.push(record);
  };

  /** Diagnostics may wait for the current view without bypassing the one tile a frame. */
  get settled(): boolean {
    if (this.held.size !== this.keep.size) return false;
    for (const tile of this.keep) if (!this.held.has(tile)) return false;
    return true;
  }

  constructor(
    readonly lods: InstancedLod[],
    /** The most tiles filled at once. */
    readonly room: number,
    private readonly tiles: Tiles,
    /** How far from the camera tiles are filled. */
    private readonly reach: (camera: THREE.Camera) => number,
  ) {
    super();
    this.filling = lods.map((lod) => ({ lod, matrices: [] }));
    this.add(...lods);
  }

  /** Call once before rendering, with the view camera. The nearest tiles hold the chunks. */
  update(camera: THREE.Camera): void {
    eye.setFromMatrixPosition(camera.matrixWorld);
    const wanted = this.candidates;
    wanted.length = 0;
    this.tiles.near(eye, this.reach(camera), this.collect);
    // Integer comparison results avoid boxing a distance for every sort comparison.
    wanted.sort(nearest);
    this.wanted = wanted.length;
    const keep = this.keep;
    keep.clear();
    for (let i = 0; i < Math.min(wanted.length, this.room); i++) {
      const candidate = wanted[i];
      if (!candidate) throw new Error("Patches: missing candidate");
      keep.add(candidate.tile);
    }
    this.change();
  }

  /** Fill one wanted tile, in place of one no longer wanted when there is no room, or else empty one no longer wanted. */
  private change(): void {
    const keep = this.keep;
    let wanted: number | undefined;
    for (const tile of keep) {
      if (this.held.has(tile)) continue;
      wanted = tile;
      break;
    }
    let expired: number | undefined;
    for (const tile of this.held.keys()) {
      if (keep.has(tile)) continue;
      expired = tile;
      break;
    }
    if (expired !== undefined && (wanted === undefined || this.held.size >= this.room)) this.release(expired);
    if (wanted !== undefined) this.fill(wanted);
  }

  private fill(tile: number): void {
    for (const { matrices } of this.filling) matrices.length = 0;
    this.tiles.fill(tile, this.emit);
    this.held.set(
      tile,
      this.filling.map(({ lod, matrices }) => ({ lod, chunk: lod.addChunk({ matrices }) })),
    );
  }

  private release(tile: number): void {
    const chunks = this.held.get(tile);
    if (!chunks) throw new Error(`Patches: tile ${tile} is not filled`);
    this.held.delete(tile);
    for (const { lod, chunk } of chunks) lod.removeChunk(chunk);
  }
}

function nearest(a: { distance: number }, b: { distance: number }): number {
  return a.distance < b.distance ? -1 : a.distance > b.distance ? 1 : 0;
}

/**
 * The distance within which an object `size` metres across (bounding diameter) stands
 * taller than `pixels` on screen for `camera`, measured as the package measures levels:
 * on a view `height` CSS pixels tall, times `quality`.
 */
export function reachFor(camera: THREE.Camera, size: number, pixels: number, height: number, quality: number): number {
  const scale = ((camera.projectionMatrix.elements[5] ?? 1) * height) / 2;
  return (size * scale * quality) / pixels;
}

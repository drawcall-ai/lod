import * as THREE from "three/webgpu";
import type { InstancedLod } from "@drawcall/lod";

/** Where patches come from: tiles of ground, each holding instances of the InstancedLods. */
export interface Tiles {
  /** Tiles within `reach` metres of `eye`, by id, with their distance. */
  near(eye: THREE.Vector3, reach: number, visit: (tile: number, distance: number) => void): void;
  /** Writes the tile's instances: which InstancedLod (index) and its instance matrix. */
  fill(tile: number, emit: (lod: number, matrix: THREE.Matrix4) => void): void;
}

const PARKED = new THREE.Matrix4().makeScale(0, 0, 0);
const eye = new THREE.Vector3();

/**
 * Instances that exist only near the camera: grass and flowers around it, corn plants in
 * the blocks close enough to show them. A field holds millions of plants and a meadow
 * more blades, far too many for one instance list; here every InstancedLod has room for
 * `chunks` tiles' worth, and tiles within `reach` (re-measured each frame) borrow a
 * chunk, fill it and hand it back when the camera moves on. A chunk's unused instances
 * are parked at scale 0, which every level list sorts into its cheapest, empty level.
 */
export class Patches extends THREE.Object3D {
  /** View height in CSS pixels that reaches are measured on, as the package measures levels; the app sets it. */
  static height = 1080;
  private static remaining = 8;

  /** Share eight tile changes across all patch systems in this rendered frame. */
  static beginFrame(): void {
    Patches.remaining = 8;
  }
  /** Tiles that wanted a chunk in the last update, filled or not. */
  wanted = 0;
  /** Tiles filled now, and the chunk each holds. */
  private readonly held = new Map<number, number>();
  private readonly free: number[];
  private readonly used: number[];
  private readonly candidates: { tile: number; distance: number }[] = [];
  private readonly records: { tile: number; distance: number }[] = [];
  private readonly keep = new Set<number>();
  private filling = 0;
  private tile = 0;
  private readonly emit = (l: number, matrix: THREE.Matrix4): void => {
    const lod = this.lods[l];
    const room = this.perTile[l] ?? 0;
    const used = this.used[l] ?? 0;
    if (!lod || used >= room) throw new Error(`Patches: tile ${this.tile} emits more than ${room} instances for InstancedLod ${l}`);
    lod.setMatrixAt(this.filling * room + used, matrix);
    this.used[l] = used + 1;
  };
  private readonly collect = (tile: number, distance: number): void => {
    const index = this.candidates.length;
    const record = this.records[index] ?? { tile, distance };
    record.tile = tile;
    record.distance = distance;
    this.records[index] = record;
    this.candidates.push(record);
  };

  /** Diagnostics may wait for the current view without bypassing the tile budget. */
  get settled(): boolean {
    if (this.held.size !== this.keep.size) return false;
    for (const tile of this.keep) if (!this.held.has(tile)) return false;
    return true;
  }

  constructor(
    readonly lods: InstancedLod[],
    /** Instances per tile, per InstancedLod: the most any tile emits. */
    private readonly perTile: number[],
    readonly chunks: number,
    private readonly tiles: Tiles,
    /** How far from the camera tiles are filled. */
    private readonly reach: (camera: THREE.Camera) => number,
  ) {
    super();
    this.free = Array.from({ length: chunks }, (_, k) => chunks - 1 - k);
    this.used = perTile.map(() => 0);
    lods.forEach((lod, l) => {
      if (lod.count !== chunks * (perTile[l] ?? 0)) throw new Error(`Patches: ${lod.name} has room for ${lod.count}, not ${chunks} × ${perTile[l]}`);
      for (let i = 0; i < lod.count; i++) lod.setMatrixAt(i, PARKED);
    });
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
    for (let i = 0; i < Math.min(wanted.length, this.chunks); i++) {
      const candidate = wanted[i];
      if (!candidate) throw new Error("Patches: missing candidate");
      keep.add(candidate.tile);
    }
    if (Patches.remaining === 0) return;
    if (this.change()) Patches.remaining--;
  }

  private change(): boolean {
    let wanted: number | undefined;
    const keep = this.keep;
    for (const tile of keep) {
      if (this.held.has(tile)) continue;
      wanted = tile;
      break;
    }
    let expired: number | undefined;
    let reusable: number | undefined;
    for (const [tile, chunk] of this.held) {
      if (keep.has(tile)) continue;
      expired = tile;
      reusable = chunk;
      break;
    }
    if (wanted !== undefined) {
      const free = this.free.pop();
      const chunk = free ?? reusable;
      if (chunk === undefined) throw new Error("Patches: no chunk for a wanted tile");
      if (free === undefined && expired !== undefined) this.held.delete(expired);
      this.held.set(wanted, chunk);
      this.fill(wanted, chunk);
      return true;
    }
    if (expired === undefined || reusable === undefined) return false;
    this.held.delete(expired);
    this.release(reusable);
    return true;
  }

  private fill(tile: number, chunk: number): void {
    this.used.fill(0);
    this.tile = tile;
    this.filling = chunk;
    this.tiles.fill(tile, this.emit);
    // park what this tile leaves empty, in case a fuller tile had the chunk before
    for (const [l, lod] of this.lods.entries()) {
      const room = this.perTile[l] ?? 0;
      for (let i = this.used[l] ?? 0; i < room; i++) lod.setMatrixAt(chunk * room + i, PARKED);
    }
  }

  private release(chunk: number): void {
    for (const [l, lod] of this.lods.entries()) {
      const room = this.perTile[l] ?? 0;
      for (let i = 0; i < room; i++) lod.setMatrixAt(chunk * room + i, PARKED);
    }
    this.free.push(chunk);
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

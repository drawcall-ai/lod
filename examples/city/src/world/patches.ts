import * as THREE from "three/webgpu";
import type { InstancedLod } from "@drawcall/lod";
import { inShadowPass } from "../../../../packages/lod/src/three.ts";

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
 *
 * Like a Lod, it is updated by three's renderer while it lists the scene (`isLOD`), so
 * its InstancedLods, its children, sort the new instances in the same frame. Shadow passes
 * update it too, with the light's camera: those calls change nothing.
 */
export class Patches extends THREE.Object3D {
  /** View height in CSS pixels that reaches are measured on, as the package measures levels; the app sets it. */
  static height = 1080;
  readonly isLOD = true;
  autoUpdate = true;
  /** Tiles that wanted a chunk in the last update, filled or not. */
  wanted = 0;
  /** Tiles filled now, and the chunk each holds. */
  private readonly held = new Map<number, number>();
  private readonly free: number[];
  private readonly used: number[];
  private readonly candidates: { tile: number; distance: number }[] = [];
  private readonly keep = new Set<number>();

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

  /** Called by three's renderer, before its children sort: the nearest tiles within reach hold the chunks. */
  update(camera: THREE.Camera): void {
    if (inShadowPass(this)) return;
    eye.setFromMatrixPosition(camera.matrixWorld);
    const wanted = this.candidates;
    wanted.length = 0;
    this.tiles.near(eye, this.reach(camera), (tile, distance) => wanted.push({ tile, distance }));
    wanted.sort((a, b) => a.distance - b.distance);
    this.wanted = wanted.length;
    const keep = this.keep;
    keep.clear();
    for (const { tile } of wanted.slice(0, this.chunks)) keep.add(tile);
    for (const [tile, chunk] of this.held) {
      if (keep.has(tile)) continue;
      this.release(chunk);
      this.held.delete(tile);
    }
    for (const tile of keep) {
      if (this.held.has(tile)) continue;
      const chunk = this.free.pop();
      if (chunk === undefined) throw new Error("Patches: no free chunk although tiles were released");
      this.held.set(tile, chunk);
      this.fill(tile, chunk);
    }
  }

  private fill(tile: number, chunk: number): void {
    this.used.fill(0);
    this.tiles.fill(tile, (l, matrix) => {
      const lod = this.lods[l];
      const room = this.perTile[l] ?? 0;
      const used = this.used[l] ?? 0;
      if (!lod || used >= room) throw new Error(`Patches: tile ${tile} emits more than ${room} instances for InstancedLod ${l}`);
      lod.setMatrixAt(chunk * room + used, matrix);
      this.used[l] = used + 1;
    });
    // park what this tile leaves empty, in case a fuller tile had the chunk before
    this.lods.forEach((lod, l) => {
      const room = this.perTile[l] ?? 0;
      for (let i = this.used[l] ?? 0; i < room; i++) lod.setMatrixAt(chunk * room + i, PARKED);
    });
  }

  private release(chunk: number): void {
    this.lods.forEach((lod, l) => {
      const room = this.perTile[l] ?? 0;
      for (let i = 0; i < room; i++) lod.setMatrixAt(chunk * room + i, PARKED);
    });
    this.free.push(chunk);
  }
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

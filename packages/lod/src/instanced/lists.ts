import { Frustum, Matrix4, type Camera, type Renderer, type StorageBufferAttribute, type StorageInstancedBufferAttribute } from "three/webgpu";
import { has } from "../levels/draw.js";
import type { InstanceSlots } from "../levels/fade.js";
import { emptyLevels, type LodLevel } from "../levels/index.js";
import { Key } from "./key.js";
import { Sorter, type RowValues } from "./sort.js";
import type { IndirectDraw } from "./rows.js";

// Each camera that draws a Lod has lists of its own: per level the instances it draws and their fades, and the indirect
// draws of every level mesh. updateInstance fills them on the GPU (see update.ts), and is skipped for a camera while
// nothing it reads changed since its last run.

/** What one camera's sort reads besides its lists, everything in the Lod's space. */
export interface SortInputs extends Omit<RowValues, "frustum"> {
  /** The instances the camera sees, as start, count and item of `liveCounts`, flat (see clusters.ts), and how many in all. */
  ranges: readonly number[];
  instances: number;
  /** The live counts of the ranges, which only the GPU knows; null while none has one. */
  liveCounts: StorageBufferAttribute | null;
  /** Whether every range it sees lies wholly inside its frustum. */
  inside: boolean;
  /**
   * The bit of the one level each instance draws, without a fade, at any height its range's instances can have, with
   * no cullDistance and no arrival under way; else 0. Inside the camera's frustum, its lists then hold every instance
   * at that level however the camera moves.
   */
  onlyLevel: number;
  /** Bumped whenever what the instances' storage holds changed. */
  version: number;
}

/** One camera's lists: what it last sorted with, which a sort is skipped for. */
export interface CameraLists {
  /** The camera's frustum in the Lod's space, as its last update found it (see `frustumIn`). */
  readonly frustum: Frustum;
  /** Whether a sort was written for the camera: until then the level meshes draw nothing for it. */
  written: boolean;
  readonly sortKey: Key;
}

const projection = new Matrix4();

/** What a camera's sort key starts with: how it lies to the instances it sees, which says what else the key holds. */
const MODE = {
  /** It sees none: nothing draws, and no sort runs. */
  hidden: 0,
  /** The key holds everything the sort reads. */
  seen: 1,
  /** Every range wholly inside its frustum, each instance drawing one level without a fade and none culled: the key holds the level. */
  oneLevel: 2,
  /** Every range wholly inside an orthographic camera's frustum, none culled: heights are alike from anywhere, so no eye. */
  orthoInside: 3,
} as const;

/** The lists of every camera drawing one Lod, and the sorts filling them. */
export class InstanceLists {
  private readonly cameras = new Map<Camera, CameraLists>();
  private readonly sorter: Sorter;

  /** `listed` tells per level whether it has an instance list: whether it draws something. */
  constructor(listed: readonly boolean[]) {
    this.sorter = new Sorter(listed.reduce((mask, on, i) => (on ? mask | (1 << i) : mask), 0));
  }

  /** `camera`'s lists, made the first time it asks. */
  of(camera: Camera): CameraLists {
    const found = this.cameras.get(camera);
    if (found) return found;
    const lists: CameraLists = { frustum: new Frustum(), written: false, sortKey: new Key() };
    this.cameras.set(camera, lists);
    return lists;
  }

  /** Where `camera`'s lists and indirect draws lie; null before a sort was written for it. */
  slots(camera: Camera): InstanceSlots | null {
    return this.sorter.slotsOf(camera);
  }

  /** Every camera draws `draws` too, after the draws it has; where they start. */
  appendDraws(draws: readonly IndirectDraw[]): number {
    return this.sorter.appendDraws(draws);
  }

  /** Survivors' scaled matrices for `capacity` instances. */
  scaledMatrices(capacity: number): StorageInstancedBufferAttribute {
    return this.sorter.scaledMatrices(capacity);
  }

  /** Sort for `camera` at its next draw, unless nothing it sorts by changed since its last sort; `limit` bounds its buffers. */
  sort(camera: Camera, sort: SortInputs, limit: number): void {
    const lists = this.of(camera);
    const { levels, eye, scale, ortho, cull, loaded, before, progress, source, reach, ranges } = sort;
    const mode = modeOf(sort);
    // No level mesh draws for the camera (see Lod.sort): its lists are not read. The key still holds what the last
    // sort read, which a camera that looks back at the instances as it was matches: that sort's lists still hold.
    if (mode === MODE.hidden) return;
    const key = lists.sortKey.start().put(mode).put(sort.version);
    for (const value of ranges) key.put(value);
    if (mode === MODE.oneLevel) key.put(sort.onlyLevel);
    else if (mode === MODE.orthoInside) key.screen(scale, ortho, levels, cull, source).put(loaded).put(before).put(progress).put(reach);
    else if (mode === MODE.seen) {
      for (const { normal, constant } of lists.frustum.planes) key.put(normal.x).put(normal.y).put(normal.z).put(constant);
      key.camera(eye, scale, ortho, levels, cull, source).put(loaded).put(before).put(progress).put(reach);
    }
    // Live counts may change at any time: their ranges sort at every update.
    if (!key.end() && !sort.liveCounts) return;
    const values = { levels, eye, scale, ortho, cull, loaded, before, progress, source, reach, frustum: lists.frustum };
    this.sorter.write(camera, values, ranges, sort.liveCounts, sort.instances, limit);
    lists.written = true;
  }

  /** Sort for `camera` on `renderer`, reading `matrices`, if due: before a level mesh draws for it. */
  drawFor(renderer: Renderer, camera: Camera, matrices: StorageInstancedBufferAttribute): void {
    this.sorter.run(renderer, camera, matrices);
  }

  /** Give back the lists of every camera other than `camera` that `rendering` says stopped drawing, as a clone made for one frame does. */
  prune(camera: Camera, rendering: (camera: Camera) => boolean): void {
    for (const other of [...this.cameras.keys()]) if (other !== camera && !rendering(other)) this.forget(other);
  }

  dispose(): void {
    this.cameras.clear();
    this.sorter.dispose();
  }

  private forget(camera: Camera): void {
    this.cameras.delete(camera);
    this.sorter.release(camera);
  }
}

/** Set `lists`' frustum to `camera`'s in the space of `space`, a world matrix, and return it. */
export function frustumIn(lists: CameraLists, camera: Camera, space: Matrix4): Frustum {
  projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(space);
  return lists.frustum.setFromProjectionMatrix(projection, camera.coordinateSystem, camera.reversedDepth);
}

/**
 * How the camera lies to `sort`'s instances (see MODE). Wholly inside its frustum, with no cullDistance, no instance is
 * culled wherever the camera is: instances that all draw one level fill its list alike, and an orthographic camera
 * measures their heights alike from anywhere.
 */
function modeOf({ ranges, inside, cull, onlyLevel, ortho }: SortInputs): number {
  if (ranges.length === 0) return MODE.hidden;
  if (cull !== null || !inside) return MODE.seen;
  return onlyLevel !== 0 ? MODE.oneLevel : ortho ? MODE.orthoInside : MODE.seen;
}

/** Per level of `inputs`, whether it has an instance list: whether it draws something. */
export function listedOf(inputs: readonly LodLevel[]): boolean[] {
  const empty = emptyLevels(inputs);
  return inputs.map((_, i) => !has(empty, i));
}

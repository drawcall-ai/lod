import { Frustum, Matrix4, type Box3, type Camera, type Renderer, type Sphere } from "three/webgpu";
import { has } from "../levels/draw.js";
import type { InstanceSlots } from "../levels/fade.js";
import { emptyLevels, type LodLevel } from "../levels/index.js";
import { Key } from "./key.js";
import type { RowValues, Sorter } from "./sort.js";
import type { IndirectDraw } from "./rows.js";

// Each camera that draws an InstancedLod has lists of its own: per level the instances it draws and their fades, and
// the indirect draws of every level mesh, laid out among every InstancedLod's in the camera's buffers (see rows.ts).
// updateInstance fills them on the GPU, and is skipped for a camera while nothing it reads changed since its last run.

/** What one camera's sort reads besides its lists, everything in the InstancedLod's space. */
export interface SortInputs extends Omit<RowValues, "frustum"> {
  /** Around every instance, survivors grown: no instance outside it is drawn. */
  bounds: Sphere;
  /** The same, as a box. */
  box: Box3;
  /**
   * The bit of the one level each instance draws, without a fade, at any height its chunk's instances can have, with
   * no cullDistance and no arrival under way; else 0. Inside the camera's frustum, its lists then hold every instance
   * at that level however the camera moves.
   */
  onlyLevel: number;
  /** Bumped whenever its chunks changed: what its pages hold. */
  chunks: number;
}

/**
 * One camera's lists: what it last sorted with, which a sort is skipped for, and the levels it wants loaded with what
 * they were worked out from.
 */
export interface CameraLists {
  /** The camera's frustum in the InstancedLod's space, as its last update found it (see `frustumIn`). */
  readonly frustum: Frustum;
  /** Whether a sort was written for the camera: until then the level meshes draw nothing for it. */
  written: boolean;
  sortKey: Key;
  heightsKey: Key;
  /** The heights its chunks' instances can have on the camera's screen (see `ChunkSet.heights`), for heightsKey's inputs. */
  heights: [shortest: number, tallest: number][];
  /** How often `heights` was worked out: what shownKey reads of them. */
  heightsVersion: number;
  /** The levels the camera needs loaded, as a mask, for `heights`. */
  wanted: number;
  shownKey: Key;
  /** The levels whose meshes draw for the camera, as a mask, for `heights` and what shownKey holds. */
  shown: number;
  /** The bit of the one level that every chunk's heights draw, without a fade, while no arrival is under way; else 0. */
  onlyLevel: number;
}

const projection = new Matrix4();

/** What a camera's sort key starts with: how it lies to the instances' bounds, which says what else the key holds. */
const MODE = {
  /** Outside the camera's frustum: nothing draws, and no sort runs. */
  hidden: 0,
  /** In it: the key holds everything the sort reads. */
  seen: 1,
  /** Wholly inside it, every instance drawing one level without a fade and none culled: the key holds the level. */
  oneLevel: 2,
  /** Wholly inside an orthographic camera's frustum, none culled: heights are alike from anywhere, so no eye. */
  orthoInside: 3,
} as const;

/** The lists of every camera drawing one InstancedLod: its row of a LodPool's sorts (see sort.ts). */
export class InstanceLists {
  private readonly cameras = new Map<Camera, CameraLists>();
  readonly row: number;

  /** `listed` tells per level whether it has an instance list: whether it draws something; each lists `listSize` instances. */
  constructor(
    private readonly sorter: Sorter,
    listed: readonly boolean[],
    listSize: number,
  ) {
    this.row = sorter.register(
      listed.reduce((mask, on, i) => (on ? mask | (1 << i) : mask), 0),
      listSize,
    );
  }

  /** `camera`'s lists, made the first time it asks. */
  of(camera: Camera): CameraLists {
    const found = this.cameras.get(camera);
    if (found) return found;
    this.sorter.hold(camera);
    const lists: CameraLists = {
      frustum: new Frustum(),
      written: false,
      sortKey: new Key(),
      heightsKey: new Key(),
      heights: [],
      heightsVersion: 0,
      wanted: 0,
      shownKey: new Key(),
      shown: 0,
      onlyLevel: 0,
    };
    this.cameras.set(camera, lists);
    return lists;
  }

  /** Where `camera`'s lists and indirect draws lie. */
  slots(camera: Camera): InstanceSlots {
    this.of(camera);
    return this.sorter.slotsOf(camera, this.row);
  }

  /** Every camera draws `draws` too, after the draws it has; where they start. */
  appendDraws(draws: readonly IndirectDraw[]): number {
    return this.sorter.appendDraws(this.row, draws);
  }

  /** Sort for `camera` at its next draw, unless nothing it sorts by changed since its last sort. */
  sort(camera: Camera, sort: SortInputs): void {
    const lists = this.of(camera);
    const { levels, eye, scale, ortho, cull, loaded, before, progress, source, reach } = sort;
    const { frustum } = lists;
    const mode = modeOf(frustum, sort);
    // No level mesh draws for the camera (see InstancedLod.sort): its lists are not read. The key still holds what the
    // last sort read, which a camera that looks back at the instances as it was matches: that sort's lists still hold.
    if (mode === MODE.hidden) return;
    const key = lists.sortKey.start().put(mode).put(sort.chunks);
    if (mode === MODE.oneLevel) key.put(sort.onlyLevel);
    else if (mode === MODE.orthoInside) key.screen(scale, ortho, levels, cull, source).put(loaded).put(before).put(progress).put(reach);
    else if (mode === MODE.seen) {
      for (const { normal, constant } of frustum.planes) key.put(normal.x).put(normal.y).put(normal.z).put(constant);
      key.camera(eye, scale, ortho, levels, cull, source).put(loaded).put(before).put(progress).put(reach);
    }
    if (!key.end()) return;
    this.sorter.write(camera, this.row, { levels, eye, scale, ortho, cull, loaded, before, progress, source, reach, frustum });
    lists.written = true;
  }

  /** Sort every InstancedLod due for `camera` on `renderer`: before a level mesh draws for it. */
  drawFor(renderer: Renderer, camera: Camera): void {
    this.sorter.run(renderer, camera);
  }

  /** Give back the lists of every camera other than `camera` that `rendering` says stopped drawing, as a clone made for one frame does. */
  prune(camera: Camera, rendering: (camera: Camera) => boolean): void {
    for (const other of [...this.cameras.keys()]) if (other !== camera && !rendering(other)) this.forget(other);
  }

  dispose(): void {
    for (const camera of [...this.cameras.keys()]) this.forget(camera);
    this.sorter.unregister(this.row);
  }

  private forget(camera: Camera): void {
    this.cameras.delete(camera);
    this.sorter.release(camera, this.row);
  }
}

/** Set `lists`' frustum to `camera`'s in the space of `space`, a world matrix, and return it. */
export function frustumIn(lists: CameraLists, camera: Camera, space: Matrix4): Frustum {
  projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(space);
  return lists.frustum.setFromProjectionMatrix(projection, camera.coordinateSystem, camera.reversedDepth);
}

/**
 * How `frustum` lies to `sort`'s instances (see MODE). Wholly inside it, with no cullDistance, no instance is culled
 * wherever the camera is: instances that all draw one level fill its list alike, and an orthographic camera measures
 * their heights alike from anywhere.
 */
function modeOf(frustum: Frustum, { bounds, box, cull, onlyLevel, ortho }: SortInputs): number {
  if (!frustum.intersectsSphere(bounds)) return MODE.hidden;
  if (cull !== null || !inside(frustum, box)) return MODE.seen;
  return onlyLevel !== 0 ? MODE.oneLevel : ortho ? MODE.orthoInside : MODE.seen;
}

/** Whether `box` lies wholly inside `frustum`: its corner nearest each plane's outside lies inside. */
function inside(frustum: Frustum, box: Box3): boolean {
  return frustum.planes.every(({ normal, constant }) => {
    const x = normal.x > 0 ? box.min.x : box.max.x;
    const y = normal.y > 0 ? box.min.y : box.max.y;
    const z = normal.z > 0 ? box.min.z : box.max.z;
    return normal.x * x + normal.y * y + normal.z * z + constant > 0;
  });
}

/** Per level of `inputs`, whether it has an instance list: whether it draws something. */
export function listedOf(inputs: readonly LodLevel[]): boolean[] {
  const empty = emptyLevels(inputs);
  return inputs.map((_, i) => !has(empty, i));
}

import { StorageInstancedBufferAttribute, type Camera, type Frustum, type Renderer, type Sphere, type Vector3 } from "three/webgpu";
import type { d } from "typegpu";
import type { DrawLevels } from "../levels/draw.js";
import type { InstanceSlots } from "../levels/fade.js";
import type { Cull } from "./cull.js";
import { releaseArrays, type InstancePagePool } from "./pages/index.js";
import {
  FLOATS_AT,
  FLOAT_ROW,
  INTS_AT,
  INT_ROW,
  RowLayout,
  disposeBuffers,
  floatsOf,
  forcedWord,
  markWords,
  setSorting,
  wordsOf,
  type CameraBuffers,
  type IndirectDraw,
} from "./rows.js";
import { sortPasses, type SortBuffers, type SortPasses } from "./update.js";

// Every InstancedLod of a LodPool sorts with the same two passes (see update.ts), each its own row of a camera's rows:
// one renderer.compute call per camera sorts every InstancedLod whose row is due, at the camera's first level mesh
// draw. A camera's buffers, its rows, lists and indirect draws, are its own, so a camera's sort reads only what its
// InstancedLods wrote for it; the counts, which the indirect pass clears, and the draws are shared.
//
// Where each row's lists and draws lie follows from the rows (see rows.ts): after a row was registered, freed or given
// draws, every camera sorts every row it holds again with the values it last sorted with, at their new positions, before it
// next draws.

/** What one InstancedLod sorts by for a camera, everything in its space. */
export interface RowValues {
  levels: d.Infer<typeof DrawLevels>;
  /** The level loading state levelsToDraw reads (see LodLevelLoadManager). */
  loaded: number;
  before: number;
  progress: number;
  eye: Vector3;
  /** Pixels per unit of subtense (or of size, for an orthographic camera). */
  scale: number;
  ortho: boolean;
  cull: Cull | null;
  /** One instance's source sphere, and how far its levels and their sway reach. */
  source: Sphere;
  reach: number;
  frustum: Frustum;
}

/** The rows of every InstancedLod of a LodPool, every camera's buffers, and the passes sorting into them. */
export class Sorter {
  private readonly layout = new RowLayout();
  private readonly cameras = new Map<Camera, CameraBuffers>();
  /** Survivors' scaled matrices, made once a row scales them; their CPU array is dropped once a pass wrote them. */
  private scaled: StorageInstancedBufferAttribute | null = null;
  /** Where survivors' scaled matrices go while none scale: never written, as no survivor scales. */
  private readonly unscaled = new StorageInstancedBufferAttribute(new Float32Array(16), 16);
  private passes: SortPasses | null = null;
  private disposed = false;

  constructor(private readonly pool: InstancePagePool) {}

  /** A row for an InstancedLod whose levels of `listed`, a mask, list up to `listSize` instances each. */
  register(listed: number, listSize: number): number {
    this.check();
    return this.layout.register(listed, listSize);
  }

  /** Free `row`: its InstancedLod is disposed. */
  unregister(row: number): void {
    for (const buffers of this.cameras.values()) idle(buffers, row);
    this.layout.unregister(row);
  }

  /** `row` draws `draws` too, after those it has; where they start among its draws. */
  appendDraws(row: number, draws: readonly IndirectDraw[]): number {
    return this.layout.appendDraws(row, draws);
  }

  /** Survivors' scaled matrices, every pool index's: one buffer, as pool indices are unique to their InstancedLod. */
  get scaledMatrices(): StorageInstancedBufferAttribute {
    return (this.scaled ??= new StorageInstancedBufferAttribute(new Float32Array(this.pool.capacity * 16), 16));
  }

  /** An InstancedLod draws for `camera`: its buffers are made with the first. */
  hold(camera: Camera): void {
    this.check();
    this.layOut();
    const buffers = this.cameras.get(camera) ?? this.layout.makeBuffers();
    buffers.users++;
    this.cameras.set(camera, buffers);
  }

  /** An InstancedLod stops drawing for `camera`, its row `row` dropped from it; the last frees its buffers. */
  release(camera: Camera, row: number): void {
    const buffers = this.cameras.get(camera);
    if (!buffers) return;
    idle(buffers, row);
    if (--buffers.users > 0) return;
    this.cameras.delete(camera);
    disposeBuffers(buffers);
  }

  /** Where `row`'s lists and draws lie for `camera`. */
  slotsOf(camera: Camera, row: number): InstanceSlots {
    this.layOut();
    const { indices, fades, args } = this.buffersOf(camera);
    return { indices, fades, args: { attribute: args, offset: this.layout.argsOffset(row) } };
  }

  /** Write `values` as what `row` sorts by for `camera`, sorted at the camera's next draw. */
  write(camera: Camera, row: number, values: RowValues): void {
    this.layOut();
    const buffers = this.buffersOf(camera);
    const { levels, loaded, before, progress, eye, scale, ortho, cull, source, reach, frustum } = values;
    const words = wordsOf(buffers);
    const base = row * INT_ROW * 4;
    words.set([levels.count, levels.coarsest, forcedWord(levels.forced)], base + INTS_AT.levels * 4);
    words.set([levels.empty, levels.fades, loaded, before], base + INTS_AT.masks * 4);
    words.set([Number(ortho), Number(cull !== null), Number(cull?.survivors ?? false)], base + INTS_AT.flags * 4);
    this.layout.place(buffers, row);
    setSorting(buffers, row, 1);
    markWords(buffers, base, INT_ROW * 4);
    const floats = floatsOf(buffers);
    const at = row * FLOAT_ROW * 4;
    floats.set(levels.maxPixels, at + FLOATS_AT.low * 4);
    floats.set([eye.x, eye.y, eye.z, scale], at + FLOATS_AT.eye * 4);
    floats.set([source.center.x, source.center.y, source.center.z, source.radius], at + FLOATS_AT.source * 4);
    floats.set([progress, reach, cull?.near ?? 0, cull?.far ?? 1], at + FLOATS_AT.values * 4);
    if (cull) floats.set([cull.eye.x, cull.eye.y, cull.eye.z, 0], at + FLOATS_AT.cullEye * 4);
    frustum.planes.forEach(({ normal, constant }, i) => floats.set([normal.x, normal.y, normal.z, constant], at + (FLOATS_AT.planes + i) * 4));
    buffers.floats.addUpdateRange(at, FLOAT_ROW * 4);
    buffers.floats.needsUpdate = true;
    buffers.held.add(row);
    buffers.due.add(row);
  }

  /** Sort every row due for `camera` on `renderer`, in one compute call: before a level mesh draws for it. */
  run(renderer: Renderer, camera: Camera): void {
    this.layOut();
    const buffers = this.cameras.get(camera);
    if (!buffers || buffers.due.size === 0) return;
    const sort = this.sortBuffers(buffers);
    const { scaled } = this;
    const passes = (this.passes ??= sortPasses(sort, this.pool.pages));
    passes.point(sort, this.layout.length);
    renderer.compute([passes.update, passes.indirect]);
    buffers.whole = false;
    // Sorted: the rows wait as they are until written again, their sorting bits cleared with the next upload.
    for (const row of buffers.due) setSorting(buffers, row, 0);
    buffers.due.clear();
    // The pass made the scaled matrices' buffer: only the GPU writes them.
    if (scaled && scaled.array.length > 0) releaseArrays([scaled]);
  }

  dispose(): void {
    this.disposed = true;
    for (const buffers of this.cameras.values()) disposeBuffers(buffers);
    this.cameras.clear();
    this.layout.dispose();
    this.scaled?.dispose();
    this.unscaled.dispose();
    this.passes?.dispose();
    this.passes = null;
  }

  private check(): void {
    if (this.disposed) throw new Error("LodPool: disposed");
  }

  private layOut(): void {
    this.layout.layOut(this.cameras.values());
  }

  private buffersOf(camera: Camera): CameraBuffers {
    const buffers = this.cameras.get(camera);
    if (!buffers) throw new Error("LodPool: no buffers for the camera");
    return buffers;
  }

  private sortBuffers({ words, floats, indices, fades, args }: CameraBuffers): SortBuffers {
    return {
      words,
      floats,
      indices,
      fades,
      args,
      matrices: this.pool.matrices,
      scaled: this.scaled ?? this.unscaled,
      counts: this.layout.counts,
      occupied: this.pool.occupied,
      draws: this.layout.draws,
    };
  }
}

/** `buffers` no longer sort `row`: its InstancedLod lets go of the camera, or is disposed. */
function idle(buffers: CameraBuffers, row: number): void {
  if (!buffers.held.delete(row)) return;
  buffers.due.delete(row);
  setSorting(buffers, row, 0);
}

import { StorageBufferAttribute, StorageInstancedBufferAttribute, type Camera, type Frustum, type IndirectStorageBufferAttribute, type Renderer, type Sphere, type Vector3 } from "three/webgpu";
import type { d } from "typegpu";
import { MAX_LEVELS, type DrawLevels } from "../levels/draw.js";
import type { InstanceSlots } from "../levels/fade.js";
import type { LodLiveCount } from "./clusters.js";
import type { Cull } from "./cull.js";
import { BLOCKS_AT, FLOATS_AT, INTS_AT, NO_LIVE_COUNT, UNLISTED, argsBuffer, countsBuffer, drawWords, floatsBuffer, forcedWord, wordsBuffer, type IndirectDraw } from "./rows.js";
import { BLOCK, MAX_BLOCKS, sortPasses, type SortPasses } from "./update.js";

// A Lod sorts its instances for each camera with two passes of its own (see update.ts), one renderer.compute call at
// the camera's first level mesh draw. A camera's buffers, its row, blocks, lists and indirect draws, are its own, so a
// camera's sort reads only what the Lod wrote for it; the counts, which the indirect pass clears, and the draws are
// shared. After the draws change, every camera sorts again with the values it last sorted with before it next draws.

/** What a Lod sorts by for a camera, everything in its space. */
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

/** One camera's buffers. */
interface CameraBuffers {
  /** Its row's u32s, followed by the blocks of instances it sorts (see rows.ts), and its f32s. */
  words: StorageBufferAttribute;
  readonly floats: StorageBufferAttribute;
  /** How many blocks it sorts. */
  blockCount: number;
  /** The live counts of the ranges it sorts; null while none has one. */
  liveCounts: LodLiveCount["attribute"] | null;
  /** Its lists: per slot, the instance it draws and its signed fade; `listSize` slots per listed level. */
  indices: StorageBufferAttribute;
  fades: StorageBufferAttribute;
  listSize: number;
  /** Its indirect draws, five words each, in the order of the draws. */
  args: IndirectStorageBufferAttribute;
  /** Whether it sorts at its next draw. */
  due: boolean;
}

/** One Lod's sorts: every camera's buffers, and the passes sorting into them. */
export class Sorter {
  private readonly cameras = new Map<Camera, CameraBuffers>();
  private readonly draws: IndirectDraw[] = [];
  private drawBuffer = drawWords([]);
  private readonly counts = countsBuffer();
  /** Survivors' scaled matrices, made once survivors scale; their CPU array is dropped once a pass wrote them. */
  private scaled: { attribute: StorageInstancedBufferAttribute; capacity: number } | null = null;
  /** Where survivors' scaled matrices go while none scale: never written, as no survivor scales. */
  private readonly unscaled = new StorageInstancedBufferAttribute(new Float32Array(16), 16);
  /** What the sort reads as live counts while no range has one: never read. */
  private readonly noLiveCounts = new StorageBufferAttribute(new Uint32Array(1), 1);
  private passes: SortPasses | null = null;

  /** `listed` tells, as a mask, which levels have an instance list: those that draw something. */
  constructor(private readonly listed: number) {}

  /** The meshes draw `draws` too, after those they have; where they start among the draws. */
  appendDraws(draws: readonly IndirectDraw[]): number {
    const first = this.draws.length;
    this.draws.push(...draws);
    this.drawBuffer.dispose();
    this.drawBuffer = drawWords(this.draws);
    for (const buffers of this.cameras.values()) {
      buffers.args.dispose();
      buffers.args = argsBuffer(this.draws.length);
      this.place(buffers);
      buffers.due = true;
    }
    return first;
  }

  /** Survivors' scaled matrices for `capacity` instances. */
  scaledMatrices(capacity: number): StorageInstancedBufferAttribute {
    if (this.scaled?.capacity !== capacity) {
      this.scaled?.attribute.dispose();
      this.scaled = { attribute: new StorageInstancedBufferAttribute(new Float32Array(capacity * 16), 16), capacity };
    }
    return this.scaled.attribute;
  }

  /** Where `camera`'s lists and indirect draws lie; null before a sort was written for it. */
  slotsOf(camera: Camera): InstanceSlots | null {
    const buffers = this.cameras.get(camera);
    return buffers ? { indices: buffers.indices, fades: buffers.fades, args: { attribute: buffers.args, offset: 0 } } : null;
  }

  /**
   * Write `values` as what `camera` sorts by, over the instances of `ranges` (start, count and item of `liveCounts`,
   * flat), `instances` in all, sorted at the camera's next draw. Its lists grow to hold them, within `limit` bytes per
   * buffer.
   */
  write(camera: Camera, values: RowValues, ranges: readonly number[], liveCounts: LodLiveCount["attribute"] | null, instances: number, limit: number): void {
    const buffers = this.cameras.get(camera) ?? this.makeBuffers();
    this.cameras.set(camera, buffers);
    if (instances > buffers.listSize) this.grow(buffers, instances, limit);
    this.writeBlocks(buffers, ranges);
    buffers.liveCounts = liveCounts;
    const { levels, loaded, before, progress, eye, scale, ortho, cull, source, reach, frustum } = values;
    const words = buffers.words.array;
    words.set([levels.count, levels.coarsest, forcedWord(levels.forced)], INTS_AT.levels * 4);
    words.set([levels.empty, levels.fades, loaded, before], INTS_AT.masks * 4);
    words.set([Number(ortho), Number(cull !== null), Number(cull?.survivors ?? false)], INTS_AT.flags * 4);
    this.place(buffers);
    const floats = buffers.floats.array;
    floats.set(levels.maxPixels, FLOATS_AT.low * 4);
    floats.set([eye.x, eye.y, eye.z, scale], FLOATS_AT.eye * 4);
    floats.set([source.center.x, source.center.y, source.center.z, source.radius], FLOATS_AT.source * 4);
    floats.set([progress, reach, cull?.near ?? 0, cull?.far ?? 1], FLOATS_AT.values * 4);
    if (cull) floats.set([cull.eye.x, cull.eye.y, cull.eye.z, 0], FLOATS_AT.cullEye * 4);
    frustum.planes.forEach(({ normal, constant }, i) => floats.set([normal.x, normal.y, normal.z, constant], (FLOATS_AT.planes + i) * 4));
    buffers.floats.needsUpdate = true;
    buffers.due = true;
  }

  /** Sort for `camera` on `renderer`, in one compute call, if due: before a level mesh draws for it. */
  run(renderer: Renderer, camera: Camera, matrices: StorageInstancedBufferAttribute): void {
    const buffers = this.cameras.get(camera);
    if (!buffers?.due) return;
    const sort = {
      ...buffers,
      matrices,
      liveCounts: buffers.liveCounts ?? this.noLiveCounts,
      scaled: this.scaled?.attribute ?? this.unscaled,
      counts: this.counts,
      draws: this.drawBuffer,
    };
    const passes = (this.passes ??= sortPasses(sort));
    passes.point(sort, buffers.blockCount);
    renderer.compute([passes.update, passes.indirect]);
    buffers.due = false;
    // The pass made the scaled matrices' buffer: only the GPU writes them.
    if (this.scaled && this.scaled.attribute.array.length > 0) this.scaled.attribute.array = new Float32Array(0);
  }

  /** `camera` no longer draws the Lod: its buffers are freed. */
  release(camera: Camera): void {
    const buffers = this.cameras.get(camera);
    if (!buffers) return;
    this.cameras.delete(camera);
    disposeBuffers(buffers);
  }

  dispose(): void {
    for (const buffers of this.cameras.values()) disposeBuffers(buffers);
    this.cameras.clear();
    this.drawBuffer.dispose();
    this.counts.dispose();
    this.scaled?.attribute.dispose();
    this.unscaled.dispose();
    this.noLiveCounts.dispose();
    this.passes?.dispose();
    this.passes = null;
  }

  private makeBuffers(): CameraBuffers {
    return {
      words: wordsBuffer(1),
      floats: floatsBuffer(),
      blockCount: 1,
      liveCounts: null,
      indices: new StorageBufferAttribute(new Uint32Array(1), 1),
      fades: new StorageBufferAttribute(new Float32Array(1), 1),
      listSize: 0,
      args: argsBuffer(this.draws.length),
      due: false,
    };
  }

  /** Grow `buffers`' lists to hold `instances` per level, by doubling, each buffer within `limit` bytes. */
  private grow(buffers: CameraBuffers, instances: number, limit: number): void {
    let size = Math.max(buffers.listSize, 1);
    while (size < instances) size *= 2;
    const slots = countBits(this.listed) * size;
    if (slots * 4 > limit)
      throw new RangeError(
        `Lod: lists of ${size} instances for each of its ${countBits(this.listed)} levels take ${slots * 4} bytes, more than the device's storage binding of ${limit} bytes: draw fewer instances in view of one camera per Lod, or raise maxStorageBufferBindingSize in the renderer's requiredLimits`,
      );
    buffers.indices.dispose();
    buffers.fades.dispose();
    buffers.indices = new StorageBufferAttribute(new Uint32Array(slots), 1);
    buffers.fades = new StorageBufferAttribute(new Float32Array(slots), 1);
    buffers.listSize = size;
  }

  /** Write the blocks of `ranges` into `buffers`, growing its words: one empty block for none, as a dispatch visits one at least. */
  private writeBlocks(buffers: CameraBuffers, ranges: readonly number[]): void {
    let count = 0;
    for (let i = 0; i < ranges.length; i += 3) count += Math.ceil((ranges[i + 1] ?? 0) / BLOCK);
    if (count > MAX_BLOCKS)
      throw new RangeError(`Lod: a camera sees ${count} blocks of ${BLOCK} instances, more than one dispatch's ${MAX_BLOCKS}: split the instances across Lods`);
    if (buffers.words.array.length < BLOCKS_AT + Math.max(count, 1) * 4) {
      buffers.words.dispose();
      buffers.words = wordsBuffer(count);
    }
    const words = buffers.words.array;
    let at = BLOCKS_AT;
    for (let i = 0; i < ranges.length; i += 3) {
      const start = ranges[i] ?? 0;
      const end = start + (ranges[i + 1] ?? 0);
      const live = ranges[i + 2] ?? NO_LIVE_COUNT;
      for (let first = start; first < end; first += BLOCK, at += 4) words.set([first, end, start, live], at);
    }
    if (count === 0) words.set([0, 0, 0, NO_LIVE_COUNT], at);
    buffers.blockCount = Math.max(count, 1);
    buffers.words.needsUpdate = true;
  }

  /** Write the layout of `buffers`' lists and the draw count into its row. */
  private place(buffers: CameraBuffers): void {
    const words = buffers.words.array;
    words[INTS_AT.flags * 4 + 3] = this.draws.length;
    words[INTS_AT.layout * 4] = buffers.listSize;
    let next = 0;
    for (let level = 0; level < MAX_LEVELS; level++) {
      const on = (this.listed & (1 << level)) !== 0;
      words[INTS_AT.starts * 4 + level] = on ? next : UNLISTED;
      if (on) next += buffers.listSize;
    }
    buffers.words.needsUpdate = true;
  }
}

function disposeBuffers({ words, floats, indices, fades, args }: CameraBuffers): void {
  for (const attribute of [words, floats, indices, fades, args]) attribute.dispose();
}

/** Set bits of `mask`. */
function countBits(mask: number): number {
  let count = 0;
  for (let bits = mask; bits !== 0; bits &= bits - 1) count++;
  return count;
}

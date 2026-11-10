import { IndirectStorageBufferAttribute, StorageBufferAttribute } from "three/webgpu";
import { MAX_LEVELS } from "../levels/draw.js";

// Where every InstancedLod of a LodGpu lies in a camera's buffers: its row of what it sorts by, its lists and its
// indirect draws. A row's place follows from the rows before it: once a row was registered, freed or given draws, the
// next use lays every row out anew (see `RowLayout.layOut`).

/** vec4s per row of u32s and of f32s: what one InstancedLod sorts by for a camera, in two buffers (see `INTS_AT`). */
export const INT_ROW = 6;
export const FLOAT_ROW = 12;

/**
 * Where each vec4 of a row lies. Of its u32s (`INTS_AT`): `levels`, the level count, the coarsest level, the forced
 * level as `forcedWord` writes it, and whether the row is sorting (1) or waits as it last sorted (0); `masks`, the
 * levels that draw nothing, whether they fade (1 or 0), those loaded and those loaded before; `flags`, whether the
 * camera is orthographic, cullDistance is set and its survivors scale (1 or 0), and the row's draw count; `layout`,
 * slots per list and the row's first draw; `starts`, per level the first slot of its list, `UNLISTED` for none. Of its
 * f32s (`FLOATS_AT`): maxPixels of levels 0 to 3 and 4 to 7, the camera in its space (eye and pixels per unit of
 * subtense, or of size, ortho), one instance's source sphere, the arrival's progress, the reach of every level and its
 * sway, cullDistance's near and far, cullDistance's camera, and the frustum's six planes.
 */
export const INTS_AT = { levels: 0, masks: 1, flags: 2, layout: 3, starts: 4 } as const;
export const FLOATS_AT = { low: 0, high: 1, eye: 2, source: 3, values: 4, cullEye: 5, planes: 6 } as const;

/** The u32 of the sorting bit, in a row's u32s. */
const SORTING_AT = INTS_AT.levels * 4 + 3;

/** The forced level as a row's u32 holds it: one more, so that 0 is none (-1). */
export const forcedWord = (forced: number) => forced + 1;

/** The start of a level without a list. */
export const UNLISTED = 0xffffffff;

/** Counts kept per row: one per level. */
export const COUNTS_PER_ROW = MAX_LEVELS;

/** Bytes per indirect draw, including the unused final word of a non-indexed draw. */
export const DRAW_BYTES = 20;

/** One indirect draw: a level's mesh, drawing `count` indices (or vertices) from `start`. */
export interface IndirectDraw {
  level: number;
  count: number;
  start: number;
  indexed: boolean;
}

/** A row's InstancedLod: its listed levels, as a mask, the slots of each list, its draws, and where they lie. */
interface Row {
  readonly listed: number;
  readonly listSize: number;
  readonly draws: IndirectDraw[];
  listBase: number;
  drawBase: number;
}

/** One camera's buffers, the rows it holds values for, and those due to sort. */
export interface CameraBuffers {
  /** Its rows' u32s and f32s. */
  words: StorageBufferAttribute;
  floats: StorageBufferAttribute;
  /** Its lists: per slot, the pool index it draws and its signed fade. */
  indices: StorageBufferAttribute;
  fades: StorageBufferAttribute;
  /** Its indirect draws, five words each, in the order of the rows' draws. */
  args: IndirectStorageBufferAttribute;
  /** Whether its words go up whole with the next sort, as after a layout: no range of them is marked then. */
  whole: boolean;
  readonly held: Set<number>;
  readonly due: Set<number>;
  /** The InstancedLods drawing for the camera. */
  users: number;
}

/** The rows of every InstancedLod of a LodGpu, where their lists and draws lie, and the buffers every camera shares. */
export class RowLayout {
  private readonly rows: (Row | null)[] = [];
  private readonly free: number[] = [];
  private slots = 0;
  private drawCount = 0;
  /** Every row's draws, from its first (see `drawWords`). */
  draws: StorageBufferAttribute = drawWords([]);
  /** Per row and level, how many instances it holds for the camera sorting: the indirect pass clears them. */
  counts: StorageBufferAttribute = countsBuffer(0);
  /** Whether the rows changed since they were laid out. */
  private moved = false;

  /** How many rows there are, freed ones included. */
  get length(): number {
    return this.rows.length;
  }

  /** A row for an InstancedLod whose levels of `listed`, a mask, list up to `listSize` instances each. */
  register(listed: number, listSize: number): number {
    const row = this.free.pop() ?? this.rows.length;
    this.rows[row] = { listed, listSize, draws: [], listBase: 0, drawBase: 0 };
    this.moved = true;
    return row;
  }

  /** Free `row`: its InstancedLod is disposed. */
  unregister(row: number): void {
    this.rows[row] = null;
    this.free.push(row);
    this.moved = true;
  }

  /** `row` draws `draws` too, after those it has; where they start among its draws. */
  appendDraws(row: number, draws: readonly IndirectDraw[]): number {
    const { draws: own } = this.rowAt(row);
    const first = own.length;
    own.push(...draws);
    this.moved = true;
    return first;
  }

  /** Byte offset of `row`'s first draw in a camera's args. */
  argsOffset(row: number): number {
    return this.rowAt(row).drawBase * DRAW_BYTES;
  }

  /**
   * Lay every row's lists and draws out anew if they moved, with every camera's buffers fitted to them: each gets
   * fresh args, as a row's old place holds another's words, and every row it holds is due to sort at its new place.
   */
  layOut(cameras: Iterable<CameraBuffers>): void {
    if (!this.moved) return;
    this.moved = false;
    let slots = 0;
    const all: IndirectDraw[] = [];
    for (const row of this.rows) {
      if (!row) continue;
      row.listBase = slots;
      row.drawBase = all.length;
      slots += countBits(row.listed) * row.listSize;
      all.push(...row.draws);
    }
    this.slots = slots;
    this.drawCount = all.length;
    this.draws.dispose();
    this.draws = drawWords(all);
    if (this.counts.count < this.rows.length * COUNTS_PER_ROW) {
      this.counts.dispose();
      this.counts = countsBuffer(this.rows.length);
    }
    for (const buffers of cameras) {
      this.fit(buffers);
      // Every row of it moved: the whole buffer goes up.
      buffers.words.clearUpdateRanges();
      buffers.words.needsUpdate = true;
      buffers.whole = true;
      for (const row of buffers.held) {
        this.place(buffers, row);
        setSorting(buffers, row, 1);
        buffers.due.add(row);
      }
    }
  }

  /** Write `row`'s layout and draw count into `buffers`' words. */
  place(buffers: CameraBuffers, row: number): void {
    const { listBase, listSize, listed, drawBase, draws } = this.rowAt(row);
    const words = wordsOf(buffers);
    const base = row * INT_ROW * 4;
    words[base + INTS_AT.flags * 4 + 3] = draws.length;
    words.set([listSize, drawBase, 0, 0], base + INTS_AT.layout * 4);
    let next = listBase;
    for (let level = 0; level < COUNTS_PER_ROW; level++) {
      const on = (listed & (1 << level)) !== 0;
      words[base + INTS_AT.starts * 4 + level] = on ? next : UNLISTED;
      if (on) next += listSize;
    }
  }

  /** A camera's buffers, sized to the layout. */
  makeBuffers(): CameraBuffers {
    return {
      words: wordsBuffer(this.rows.length),
      floats: floatsBuffer(this.rows.length),
      indices: new StorageBufferAttribute(new Uint32Array(Math.max(this.slots, 1)), 1),
      fades: new StorageBufferAttribute(new Float32Array(Math.max(this.slots, 1)), 1),
      args: argsBuffer(this.drawCount),
      whole: false,
      held: new Set(),
      due: new Set(),
      users: 0,
    };
  }

  dispose(): void {
    this.draws.dispose();
    this.counts.dispose();
  }

  private rowAt(row: number): Row {
    const found = this.rows[row];
    if (!found) throw new Error(`LodGpu: row ${row} holds no InstancedLod`);
    return found;
  }

  /** Grow `buffers` to the layout, keeping what its rows hold, with fresh args. */
  private fit(buffers: CameraBuffers): void {
    if (buffers.words.count < this.rows.length * INT_ROW) {
      const words = wordsBuffer(this.rows.length);
      const floats = floatsBuffer(this.rows.length);
      new Uint32Array(words.array.buffer).set(wordsOf(buffers));
      new Float32Array(floats.array.buffer).set(floatsOf(buffers));
      buffers.words.dispose();
      buffers.floats.dispose();
      buffers.words = words;
      buffers.floats = floats;
    }
    if (buffers.indices.count < this.slots) {
      buffers.indices.dispose();
      buffers.fades.dispose();
      buffers.indices = new StorageBufferAttribute(new Uint32Array(this.slots), 1);
      buffers.fades = new StorageBufferAttribute(new Float32Array(this.slots), 1);
    }
    buffers.args.dispose();
    buffers.args = argsBuffer(this.drawCount);
  }
}

/** Set `row`'s sorting bit in `buffers` to `sorting`, uploaded with the camera's next sort. */
export function setSorting(buffers: CameraBuffers, row: number, sorting: number): void {
  const at = row * INT_ROW * 4 + SORTING_AT;
  wordsOf(buffers)[at] = sorting;
  markWords(buffers, at, 1);
}

/** `count` of `buffers`' words from `at` changed: they go up with the camera's next sort. */
export function markWords(buffers: CameraBuffers, at: number, count: number): void {
  if (!buffers.whole) buffers.words.addUpdateRange(at, count);
  buffers.words.needsUpdate = true;
}

export function disposeBuffers({ words, floats, indices, fades, args }: CameraBuffers): void {
  for (const attribute of [words, floats, indices, fades, args]) attribute.dispose();
}

/** A camera's rows, as the u32s and the f32s its buffers hold. */
export const wordsOf = ({ words }: CameraBuffers) => new Uint32Array(words.array.buffer);
export const floatsOf = ({ floats }: CameraBuffers) => new Float32Array(floats.array.buffer);

/** The words of `draws` as the indirect pass reads them: level, count, start and whether indexed, per draw. */
export function drawWords(draws: readonly IndirectDraw[]): StorageBufferAttribute {
  const values = new Uint32Array(Math.max(draws.length, 1) * 4);
  draws.forEach((draw, i) => values.set([draw.level, draw.count, draw.start, Number(draw.indexed)], i * 4));
  return new StorageBufferAttribute(values, 4);
}

/** Set bits of `mask`. */
function countBits(mask: number): number {
  let count = 0;
  for (let bits = mask; bits !== 0; bits &= bits - 1) count++;
  return count;
}

const wordsBuffer = (rows: number) => new StorageBufferAttribute(new Uint32Array(Math.max(rows, 1) * INT_ROW * 4), 4);
const floatsBuffer = (rows: number) => new StorageBufferAttribute(new Float32Array(Math.max(rows, 1) * FLOAT_ROW * 4), 4);
const countsBuffer = (rows: number) => new StorageBufferAttribute(new Uint32Array(Math.max(rows, 1) * COUNTS_PER_ROW), 1);
/** Indirect draws only the GPU writes, zero until a sort writes them: a row draws nothing before it sorted. */
const argsBuffer = (draws: number) => new IndirectStorageBufferAttribute(new Uint32Array(Math.max(draws, 1) * (DRAW_BYTES / 4)), 1);

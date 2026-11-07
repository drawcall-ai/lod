import type { Color, Matrix4 } from "three/webgpu";
import { at } from "../at.js";
import { Blocks, type BlockView } from "./blocks.js";
import { Dirty, upload } from "./dirty.js";
import type { BlockFrame, Places, Seed } from "./places.js";
import { Runs } from "./runs.js";
import type { Selection } from "./select.js";

/** Instances added to an InstancedLod in one call and removed whole: those from index `start`, `count` of them. */
export interface InstancedChunk {
  readonly start: number;
  readonly count: number;
}

/** The instances of a chunk to add. */
export interface ChunkData {
  /** 16 floats per instance, as `Matrix4.elements`; the instance count. */
  matrices: ArrayLike<number>;
  /** Red, green and blue per instance, as `setColorAt` takes them; white without. */
  colors?: ArrayLike<number>;
  /** Per instance, its keep ratio in [0, 1) (see `InstancedRange`); 0 without. */
  keeps?: ArrayLike<number>;
}

/**
 * The CPU side of every instance: the chunks holding it, what `add` and `setMatrixAt` wrote, and the edits not yet
 * measured and uploaded. Chunks keep their indices; capacity doubles as they need it and halves once a quarter of it
 * is used, keeping the places in use.
 */
export class Store implements Places {
  /** Instance matrices, 16 floats each; a free place holds zeros, which draw nothing. */
  matrices: Float32Array;
  /** Instance keep ratios. */
  keeps: Float32Array;
  /** Instance colours, 4 floats each, once some instance has one. */
  colors: Float32Array | null = null;
  /** Each instance's bounding sphere, centre and radius, in the InstancedLod's space, as `measure` last left it. */
  spheres: Float32Array;
  readonly chunks = new Set<InstancedChunk>();
  readonly occupied = null;
  /** Instances in chunks. */
  count = 0;
  private readonly runs = new Runs();
  private live: Uint8Array;
  private changes: Dirty;
  private colorChanges: Dirty;
  /** Where edits upload to, while there is one. */
  private selection: Selection | null = null;

  constructor() {
    this.matrices = new Float32Array(0);
    this.keeps = new Float32Array(0);
    this.spheres = new Float32Array(0);
    this.live = new Uint8Array(0);
    this.changes = new Dirty(0);
    this.colorChanges = new Dirty(0);
  }

  get capacity(): number {
    return this.runs.capacity;
  }

  /** One past the last place in use: the selection visits only the places before it. */
  get end(): number {
    return this.runs.end;
  }

  check(index: number): void {
    if (!Number.isInteger(index) || this.live[index] !== 1) throw new Error(`InstancedLod: index ${index} is not an instance of a chunk`);
  }

  /** Place `data`'s instances, growing the capacity if they need it. */
  add(data: ChunkData): InstancedChunk {
    const { matrices, colors, keeps } = data;
    const count = matrices.length / 16;
    if (!Number.isInteger(count)) throw new Error(`InstancedLod: a chunk's matrices hold 16 floats per instance, got ${matrices.length}`);
    if (colors && colors.length !== count * 3) throw new Error(`InstancedLod: a chunk of ${count} instances needs ${count * 3} colour floats, got ${colors.length}`);
    if (keeps && keeps.length !== count) throw new Error(`InstancedLod: a chunk of ${count} instances needs ${count} keep ratios, got ${keeps.length}`);
    for (let i = 0; keeps && i < count; i++) {
      const keep = at(keeps, i);
      if (!(keep >= 0 && keep < 1)) throw new RangeError(`InstancedLod: keep ratio ${keep} of instance ${i} is not in [0, 1)`);
    }
    let start = this.runs.take(count);
    if (start === null) {
      let capacity = Math.max(this.capacity, 1);
      while (capacity < this.end + count) capacity *= 2;
      this.resize(capacity);
      start = this.runs.take(count);
      if (start === null) throw new Error("InstancedLod: no room after growing");
    }
    const chunk: InstancedChunk = { start, count };
    this.chunks.add(chunk);
    this.count += count;
    this.matrices.set(matrices, start * 16);
    this.keeps.fill(0, start, start + count);
    if (keeps) this.keeps.set(keeps, start);
    this.live.fill(1, start, start + count);
    const tints = colors ? this.useColors() : this.colors;
    tints?.fill(1, start * 4, (start + count) * 4);
    for (let i = 0; tints && colors && i < count; i++) {
      for (let c = 0; c < 3; c++) tints[(start + i) * 4 + c] = at(colors, i * 3 + c);
    }
    this.changed(chunk);
    // What the views drew at these places was another instance's.
    this.selection?.forgetShown(start, start + count);
    return chunk;
  }

  remove(chunk: InstancedChunk): void {
    if (!this.chunks.delete(chunk)) throw new Error("InstancedLod: the chunk is not one of its own");
    const { start, count } = chunk;
    this.count -= count;
    this.matrices.fill(0, start * 16, (start + count) * 16);
    this.live.fill(0, start, start + count);
    this.changed(chunk);
    this.runs.give(start, count);
    let capacity = this.capacity;
    while (capacity > 1 && this.end <= capacity / 4) capacity /= 2;
    if (capacity !== this.capacity) this.resize(capacity);
  }

  setMatrix(index: number, matrix: Matrix4): void {
    this.check(index);
    matrix.toArray(this.matrices, index * 16);
    this.changes.add(index);
  }

  getMatrix(index: number, matrix: Matrix4): Matrix4 {
    this.check(index);
    return matrix.fromArray(this.matrices, index * 16);
  }

  setColor(index: number, color: Color): void {
    this.check(index);
    color.toArray(this.useColors(), index * 4);
    this.colorChanges.add(index);
  }

  /** White unless set. */
  getColor(index: number, color: Color): Color {
    this.check(index);
    return this.colors ? color.fromArray(this.colors, index * 4) : color.setRGB(1, 1, 1);
  }

  /** Instance `index`'s on-screen height in `view`, as of the last `measure`; null at scale 0. */
  height(index: number, view: BlockView): number | null {
    const offset = index * 4;
    const r = at(this.spheres, offset + 3);
    if (r === 0) return null;
    const height = 2 * r * view.scale;
    if (view.ortho) return height;
    const dx = at(this.spheres, offset) - view.eye.x;
    const dy = at(this.spheres, offset + 1) - view.eye.y;
    const dz = at(this.spheres, offset + 2) - view.eye.z;
    return height / Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-6);
  }

  /** Upload edits to `selection` from now on, colours included once there are any; null stops uploading. */
  /** The store's own arrays: the selection's buffers share them, and the store uploads what it changes. */
  seed(): Seed {
    return { matrices: this.matrices, keeps: this.keeps, colors: this.colors };
  }

  attach(selection: Selection | null): void {
    this.selection = selection;
    if (selection && this.colors) selection.useColors(this.colors);
  }

  /** Take `source`'s chunks, matrices, keep ratios and colours, all of them pending. */
  copy(source: Store): void {
    if (this.chunks.size > 0) throw new Error("InstancedLod: copy into an InstancedLod without chunks");
    this.resize(source.capacity);
    this.matrices.set(source.matrices);
    this.keeps.set(source.keeps);
    if (source.colors) this.useColors().set(source.colors);
    for (const { start, count } of source.chunks) {
      if (this.runs.take(count) !== start) throw new Error("InstancedLod: copied chunks out of order");
      this.chunks.add({ start, count });
      this.live.fill(1, start, start + count);
      this.count += count;
    }
  }

  /** Blocks around every instance, at a leaf size for `frame.draws`. */
  blocks(frame: BlockFrame, survivors: boolean): Blocks {
    const blocks = new Blocks(this.capacity, this.spheres, frame.source, frame.bounds, frame.draws, frame.rest, survivors ? this.keeps : null);
    blocks.pad(frame.padding);
    blocks.measure(this.matrices, 0, this.end);
    blocks.refit();
    return blocks;
  }

  /** Nothing to prepare: `measure` sends edits as they are measured. */
  prepare(): void {}

  /** Always: chunks are taken in as they are added. */
  drained(): Promise<boolean> {
    return Promise.resolve(true);
  }

  dispose(): void {}

  /** Measure only changed instances into `blocks`; instance and colour uploads have separate ranges. */
  measure(blocks: Blocks): void {
    if (this.changes.empty && this.colorChanges.empty) return;
    this.measureChanges(blocks);
  }

  // Keep the closure-bearing work out of the unchanged path: V8 can allocate a
  // lexical context on entry even when a function returns before its callbacks.
  private measureChanges(blocks: Blocks): void {
    const { selection } = this;
    const changed = !this.changes.empty;
    this.changes.drain((start, end) => {
      blocks.measure(this.matrices, start, end);
      if (!selection) return;
      upload(selection.matrices, start, end);
      upload(selection.keeps, start, end);
    });
    this.colorChanges.drain((start, end) => {
      if (selection?.colors) upload(selection.colors, start, end);
    });
    selection?.changed();
    if (changed) blocks.refit();
  }

  /** `chunk`'s places, changed. */
  private changed({ start, count }: InstancedChunk): void {
    for (let i = start; i < start + count; i++) this.changes.add(i);
    if (!this.colors) return;
    for (let i = start; i < start + count; i++) this.colorChanges.add(i);
  }

  /** The colours, made white for every instance the first time. */
  private useColors(): Float32Array {
    if (this.colors) return this.colors;
    const colors = new Float32Array(this.capacity * 4).fill(1);
    this.colors = colors;
    this.colorChanges.all();
    this.selection?.useColors(colors);
    return colors;
  }

  /** Move every instance to arrays of `capacity` places, all of them pending: the caller rebuilds what holds the old ones. */
  private resize(capacity: number): void {
    const end = this.end;
    this.runs.resize(capacity);
    const grown = <T extends Float32Array | Uint8Array>(old: T, make: (length: number) => T, size: number): T => {
      const array = make(capacity * size);
      array.set(old.subarray(0, end * size));
      return array;
    };
    this.matrices = grown(this.matrices, (n) => new Float32Array(n), 16);
    this.keeps = grown(this.keeps, (n) => new Float32Array(n), 1);
    this.spheres = grown(this.spheres, (n) => new Float32Array(n), 4);
    this.live = grown(this.live, (n) => new Uint8Array(n), 1);
    if (this.colors) this.colors = grown(this.colors, (n) => new Float32Array(n).fill(1), 4);
    this.changes = new Dirty(capacity);
    this.colorChanges = new Dirty(capacity);
    this.changes.all();
    if (this.colors) this.colorChanges.all();
  }
}

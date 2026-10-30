import { Matrix4, type Color } from "three/webgpu";
import type { Blocks } from "./blocks.js";
import { Dirty, upload } from "./dirty.js";
import type { Selection } from "./select.js";

const IDENTITY = new Matrix4();

/** The CPU side of every instance, as `setMatrixAt` and `setColorAt` write it, and its edits not yet measured and uploaded. */
export class Store {
  /** Instance matrices, 16 floats each: the selection uploads them from here. */
  readonly matrices: Float32Array;
  /** Instance colours, 4 floats each, once `setColor` was called. */
  colors: Float32Array | null = null;
  /** Each instance's bounding sphere, centre and radius, in the InstancedLod's space. */
  readonly spheres: Float32Array;
  private readonly matrixChanges: Dirty;
  private readonly colorChanges: Dirty;
  /** Where edits upload to, while there is one. */
  private selection: Selection | null = null;

  constructor(readonly count: number) {
    this.matrices = new Float32Array(count * 16);
    this.spheres = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) IDENTITY.toArray(this.matrices, i * 16);
    this.matrixChanges = new Dirty(count);
    this.colorChanges = new Dirty(count);
    this.matrixChanges.all();
  }

  check(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) throw new Error(`InstancedLod: index ${index} is not in 0..${this.count - 1}`);
  }

  setMatrix(index: number, matrix: Matrix4): void {
    this.check(index);
    matrix.toArray(this.matrices, index * 16);
    this.matrixChanges.add(index);
  }

  getMatrix(index: number, matrix: Matrix4): Matrix4 {
    this.check(index);
    return matrix.fromArray(this.matrices, index * 16);
  }

  setColor(index: number, color: Color): void {
    this.check(index);
    if (!this.colors) {
      this.colors = new Float32Array(this.count * 4).fill(1);
      if (this.selection) {
        this.selection.useColors(this.colors);
        this.colorChanges.all();
      }
    }
    color.toArray(this.colors, index * 4);
    this.colorChanges.add(index);
  }

  /** White unless set. */
  getColor(index: number, color: Color): Color {
    this.check(index);
    return this.colors ? color.fromArray(this.colors, index * 4) : color.setRGB(1, 1, 1);
  }

  /** Upload edits to `selection` from now on, colours included once there are any; null stops uploading. */
  attach(selection: Selection | null): void {
    this.selection = selection;
    if (selection && this.colors) selection.useColors(this.colors);
  }

  /** Take `source`'s matrices and colours, all of them pending. */
  copy(source: Store): void {
    this.matrices.set(source.matrices);
    this.colors = source.colors?.slice() ?? null;
    this.matrixChanges.all();
    if (this.colors) this.colorChanges.all();
  }

  /** Measure only changed matrices into `blocks`; matrix and colour uploads have separate ranges. */
  measure(blocks: Blocks): void {
    if (this.matrixChanges.empty && this.colorChanges.empty) return;
    this.measureChanges(blocks);
  }

  // Keep the closure-bearing work out of the unchanged path: V8 can allocate a
  // lexical context on entry even when a function returns before its callbacks.
  private measureChanges(blocks: Blocks): void {
    const { selection } = this;
    const matricesChanged = !this.matrixChanges.empty;
    this.matrixChanges.drain((start, end) => {
      blocks.measure(start, end);
      if (selection) upload(selection.matrices, start, end);
    });
    this.colorChanges.drain((start, end) => {
      if (selection?.colors) upload(selection.colors, start, end);
    });
    selection?.changed();
    if (matricesChanged) blocks.refit();
  }
}

import { Box3, Sphere, Vector3, type InstancedBufferAttribute } from "three";

// The slots of one InstancedLod level: the instances it draws, packed into the instance-matrix
// (and instance-colour) attribute that all its meshes share. An instance that changes level
// is swap-removed from its old slots and appended to its new ones, and only the slots
// touched are written and uploaded.
//
// Typed-array reads are in bounds; their `?? 0` only answers noUncheckedIndexedAccess.

const min = new Vector3();
const box = new Box3();
const max = new Vector3();

/** The instances one level draws. */
export class Slots {
  /** slot → instance */
  readonly list: Int32Array;
  /** instance → slot, or -1 */
  readonly slotOf: Int32Array;
  length = 0;
  /** Bounds of the instances in the slots, and the largest instance radius: see `measure`. */
  readonly sphere = new Sphere();
  radius = 0;
  /** Whether the slots changed since the last `measure`. */
  private changed = true;
  /** Maximum displacement as a share of each instance's resting radius. */
  private padding = 0;
  private low = Infinity;
  private high = -1;
  /** Per-instance colours and the level's colour attribute, once colours are set. */
  private colors: { source: Float32Array; attribute: InstancedBufferAttribute } | null = null;

  constructor(
    readonly attribute: InstancedBufferAttribute,
    private readonly matrices: Float32Array,
    count: number,
  ) {
    this.list = new Int32Array(count);
    this.slotOf = new Int32Array(count).fill(-1);
  }

  /** Carry `source` (3 floats per instance) into `attribute` from now on, starting with every slot. */
  useColors(source: Float32Array, attribute: InstancedBufferAttribute): void {
    this.colors = { source, attribute };
    for (let slot = 0; slot < this.length; slot++) this.write(slot, this.list[slot] ?? 0);
  }

  add(i: number): void {
    this.changed = true;
    const slot = this.length++;
    this.list[slot] = i;
    this.slotOf[i] = slot;
    this.write(slot, i);
  }

  remove(i: number): void {
    this.changed = true;
    const slot = this.slot(i);
    const last = --this.length;
    const moved = this.list[last] ?? -1;
    this.slotOf[i] = -1;
    if (slot === last) return;
    this.list[slot] = moved;
    this.slotOf[moved] = slot;
    this.write(slot, moved);
  }

  /** Write instance `i`'s matrix again, after it changed. */
  rewrite(i: number): void {
    this.changed = true;
    this.write(this.slot(i), i);
  }

  /** Change the culling envelope without moving instances or uploading their buffers. */
  padBounds(ratio: number): void {
    this.padding = ratio;
    this.changed = true;
  }

  /** Bound the instances in the slots again if they changed, from their spheres (`x`, `y`, `z`, `r` per instance). */
  measure(x: Float32Array, y: Float32Array, z: Float32Array, r: Float32Array): void {
    if (!this.changed) return;
    this.changed = false;
    // Plain numbers rather than Box3 calls: a crowd's coarsest level holds most instances.
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    let radius = 0;
    for (let slot = 0; slot < this.length; slot++) {
      const i = this.list[slot] ?? 0;
      const ri = r[i] ?? 0;
      const xi = x[i] ?? 0;
      const yi = y[i] ?? 0;
      const zi = z[i] ?? 0;
      x0 = Math.min(x0, xi - ri);
      y0 = Math.min(y0, yi - ri);
      z0 = Math.min(z0, zi - ri);
      x1 = Math.max(x1, xi + ri);
      y1 = Math.max(y1, yi + ri);
      z1 = Math.max(z1, zi + ri);
      radius = Math.max(radius, ri);
    }
    this.radius = radius;
    if (this.length === 0) this.sphere.makeEmpty();
    else {
      box.set(min.set(x0, y0, z0), max.set(x1, y1, z1)).getBoundingSphere(this.sphere);
      if (this.padding > 0) {
        const displacement = radius * this.padding;
        this.sphere.radius += displacement;
        this.radius += displacement;
      }
    }
  }

  private slot(i: number): number {
    const slot = this.slotOf[i] ?? -1;
    if (slot < 0) throw new Error(`InstancedLod: instance ${i} is not in this level`);
    return slot;
  }

  /** Copy instance `i`'s matrix into `slot`. */
  private write(slot: number, i: number): void {
    const target = this.attribute.array;
    for (let k = 0; k < 16; k++) target[slot * 16 + k] = this.matrices[i * 16 + k] ?? 0;
    if (this.colors) {
      const { source, attribute } = this.colors;
      for (let k = 0; k < 3; k++) attribute.array[slot * 3 + k] = source[i * 3 + k] ?? 0;
    }
    this.low = Math.min(this.low, slot);
    this.high = Math.max(this.high, slot);
  }

  /** Upload the slots written since the last flush; whether there were any. */
  flush(): boolean {
    if (this.high < this.low) return false;
    upload(this.attribute, this.low, this.high);
    if (this.colors) upload(this.colors.attribute, this.low, this.high);
    this.low = Infinity;
    this.high = -1;
    return true;
  }
}

/** Upload items `low..high` of `attribute`. */
function upload(attribute: InstancedBufferAttribute, low: number, high: number): void {
  const size = attribute.itemSize;
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(low * size, (high - low + 1) * size);
  attribute.needsUpdate = true;
}

import { Matrix4, Vector3, type InstancedBufferAttribute, type Sphere } from "three";
import { FADE, type Level } from "../levels.js";
import { Slots } from "./slots.js";

// Sorting the instances of an InstancedLod into its levels.
//
// Each instance's bounding sphere is kept in structure-of-arrays form, in the
// InstancedLod's space; it is measured again only after its matrix changes. A sort then
// compares squared distances against squared thresholds per level, without square roots,
// matrices or calls per instance: the height in pixels is 2 r q / d (q: pixels per unit
// of subtense times Lod.quality), so h <= m is r² (2q / m)² <= d². This is the shaders'
// subtense in the InstancedLod's space, which equals world space as long as the
// InstancedLod's own transform scales uniformly.
//
// Each level keeps the bounds of the instances it draws, measured again whenever its
// slots change, so the views and shadow maps that miss them cull the level's draws.
//
// Typed-array reads are in bounds; their `?? 0` only answers noUncheckedIndexedAccess.

const NONE = 255;
const matrix = new Matrix4();
const centre = new Vector3();

export class Sorter {
  /** Bounding sphere per instance, in the InstancedLod's space. */
  private readonly cx: Float32Array;
  private readonly cy: Float32Array;
  private readonly cz: Float32Array;
  private readonly r: Float32Array;
  /** Per instance: its level, and the finer level it fades with (NONE for none). */
  private readonly level: Uint8Array;
  private readonly finer: Uint8Array;
  /** Instances whose matrix changed since the last sort. */
  private readonly dirty: Uint8Array;
  private anyDirty = true;
  /** Per level: squared factors of the threshold and of the fade's start; radius limits when orthographic. */
  private readonly k: Float64Array;
  private readonly kFade: Float64Array;
  private readonly rOrtho: Float64Array;
  private readonly slots: Slots[];

  constructor(
    private readonly count: number,
    private readonly matrices: Float32Array,
    private readonly sphere: Sphere,
    attributes: InstancedBufferAttribute[],
  ) {
    if (attributes.length >= NONE) throw new Error(`InstancedLod: at most ${NONE - 1} levels`);
    this.cx = new Float32Array(count);
    this.cy = new Float32Array(count);
    this.cz = new Float32Array(count);
    this.r = new Float32Array(count);
    this.level = new Uint8Array(count).fill(NONE);
    this.finer = new Uint8Array(count).fill(NONE);
    this.dirty = new Uint8Array(count).fill(1);
    this.k = new Float64Array(attributes.length);
    this.kFade = new Float64Array(attributes.length);
    this.rOrtho = new Float64Array(attributes.length);
    this.slots = attributes.map((attribute) => new Slots(attribute, matrices, count));
  }

  /** Carry `colors` (3 floats per instance) into each level's attribute in `attributes`. */
  useColors(colors: Float32Array, attributes: InstancedBufferAttribute[]): void {
    this.slots.forEach((slots, level) => {
      const attribute = attributes[level];
      if (!attribute) throw new Error(`InstancedLod: no colour attribute for level ${level}`);
      slots.useColors(colors, attribute);
    });
  }

  /** The finest level instance `i` drew in the last sort, or null before the first. */
  finest(i: number): number | null {
    const level = this.finer[i] === NONE ? (this.level[i] ?? NONE) : (this.finer[i] ?? NONE);
    return level === NONE ? null : level;
  }

  /** Instance `i`'s matrix or colour changed. */
  touch(i: number): void {
    this.dirty[i] = 1;
    this.anyDirty = true;
  }

  get changed(): boolean {
    return this.anyDirty;
  }

  /** Measure the spheres of instances whose matrix changed. */
  private measure(): void {
    if (!this.anyDirty) return;
    for (let i = 0; i < this.count; i++) {
      if (!this.dirty[i]) continue;
      matrix.fromArray(this.matrices, i * 16);
      centre.copy(this.sphere.center).applyMatrix4(matrix);
      this.cx[i] = centre.x;
      this.cy[i] = centre.y;
      this.cz[i] = centre.z;
      this.r[i] = this.sphere.radius * matrix.getMaxScaleOnAxis();
    }
  }

  /**
   * Sort for an eye at `eye` (in the InstancedLod's space), `q` pixels per unit of
   * subtense × Lod.quality. Without `fades` nothing fades.
   */
  sort(levels: readonly Level[], eye: Vector3, q: number, fades: boolean): void {
    this.measure();
    for (const level of levels) {
      this.k[level.index] = ((2 * q) / level.maxPixels) ** 2;
      this.kFade[level.index] = ((2 * q) / (level.maxPixels * (1 - FADE))) ** 2;
    }
    const { cx, cy, cz, r, k, kFade, dirty, level: levelOf, finer: finerOf } = this;
    const { x, y, z } = eye;
    const last = levels.length - 1;
    for (let i = 0; i < this.count; i++) {
      const dx = (cx[i] ?? 0) - x;
      const dy = (cy[i] ?? 0) - y;
      const dz = (cz[i] ?? 0) - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const r2 = (r[i] ?? 0) * (r[i] ?? 0);
      let level = last;
      while (level > 0 && r2 * (k[level] ?? 0) > d2) level--;
      const finer = fades && level > 0 && r2 * (kFade[level] ?? 0) > d2 ? level - 1 : NONE;
      // Most instances keep their levels; only the others pay for a call.
      if (level !== levelOf[i] || finer !== finerOf[i] || dirty[i] === 1) this.assign(i, level, finer);
    }
    this.finish();
  }

  /** Sort for an orthographic view: `q` pixels per unit of size × Lod.quality, no fades. */
  sortOrtho(levels: readonly Level[], q: number): void {
    this.measure();
    // Height 2 r q <= m: r <= m / 2q.
    for (const level of levels) this.rOrtho[level.index] = level.maxPixels / (2 * q);
    const { r, rOrtho } = this;
    const last = levels.length - 1;
    for (let i = 0; i < this.count; i++) {
      const radius = r[i] ?? 0;
      let level = last;
      while (level > 0 && radius > (rOrtho[level] ?? 0)) level--;
      this.assign(i, level, NONE);
    }
    this.finish();
  }

  /** Put every instance in `level`. */
  sortForced(level: number): void {
    this.measure();
    for (let i = 0; i < this.count; i++) this.assign(i, level, NONE);
    this.finish();
  }

  private assign(i: number, level: number, finer: number): void {
    const was = this.level[i] ?? NONE;
    const wasFiner = this.finer[i] ?? NONE;
    const moved = this.dirty[i] === 1;
    if (level === was && finer === wasFiner && !moved) return;
    if (was !== NONE && was !== level && was !== finer) this.at(was).remove(i);
    if (wasFiner !== NONE && wasFiner !== level && wasFiner !== finer) this.at(wasFiner).remove(i);
    this.place(i, level, was, wasFiner, moved);
    if (finer !== NONE) this.place(i, finer, was, wasFiner, moved);
    this.level[i] = level;
    this.finer[i] = finer;
    this.dirty[i] = 0;
  }

  /** Put instance `i` into `level`'s slots, or write it again where it already is. */
  private place(i: number, level: number, was: number, wasFiner: number, moved: boolean): void {
    const slots = this.at(level);
    if (level !== was && level !== wasFiner) slots.add(i);
    else if (moved) slots.rewrite(i);
  }

  /** How many instances `level` draws. */
  length(level: number): number {
    return this.at(level).length;
  }

  /** The bounds of the instances `level` draws, in the InstancedLod's space; shared, kept current by every sort. */
  bounds(level: number): Sphere {
    return this.at(level).sphere;
  }

  /** The largest radius of an instance `level` draws, in the InstancedLod's space. */
  radius(level: number): number {
    return this.at(level).radius;
  }

  private at(level: number): Slots {
    const slots = this.slots[level];
    if (!slots) throw new Error(`InstancedLod: no level ${level}`);
    return slots;
  }

  private finish(): void {
    this.anyDirty = false;
    for (const slots of this.slots) {
      slots.flush();
      slots.measure(this.cx, this.cy, this.cz, this.r);
    }
  }
}

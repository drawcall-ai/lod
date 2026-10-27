import { Color, type Object3D } from "three/webgpu";
import { texelPixels } from "./impostor/impostor.js";
import { isImpostorMesh } from "./three.js";

// The levels Lod and InstancedLod share: their thresholds, the defaults of those, which
// level a height picks and how far it has faded in (see fade.ts).

/**
 * A fade dithers over the top of a level's range: from maxPixels × (1 - FADE) to
 * maxPixels. Instances inside it draw twice; a narrower fade pops no more visibly, as
 * the dither spreads the switch over the frames an approach takes to cross it.
 */
export const FADE = 0.1;

/** One entry of `Lod.levels`. */
export interface LodLevel {
  readonly object: Object3D;
  /**
   * The largest on-screen height, in CSS pixels, at which this level is used
   * (heights are × `Lod.quality`). Level 0, the source, has Infinity.
   * Every further level's must be at most 0.9 of the previous one's, so that one fade has
   * ended before the next begins.
   *
   * Unless set, it is where the level is about a pixel off: for a level `simplify` or
   * `bakeMesh` returned, where its measured error reaches a pixel (a clone you make of
   * it does not carry the error; a cloned Lod keeps it); for an ImpostorMesh, where two
   * atlas texels span one pixel; else half the previous level's (512 px for level 1).
   * Such defaults are raised to twice the next level's where they would leave no room
   * for the fades.
   */
  maxPixels: number;
}

export class Level implements LodLevel {
  /** Debug tint (see `Lod.debug`), white when off; shared by every draw of the level. */
  readonly tint = new Color(1, 1, 1);
  /** maxPixels as set, or null for the default */
  explicit: number | null = null;
  /** The default before raising for the fades: see `resolve`. */
  base = Infinity;
  /** maxPixels as resolved; see `resolve` */
  value = Infinity;

  constructor(
    readonly object: Object3D,
    readonly index: number,
    /** A nested LOD switches its own levels and fades by them, not by its parent. */
    readonly nested: boolean,
    /** The levels this one is in, which its default depends on. */
    private readonly ladder: readonly Level[],
  ) {}

  get maxPixels(): number {
    return this.value;
  }

  set maxPixels(value: number) {
    if (this.index === 0 && value !== Infinity) throw new Error(`Lod: level 0, the source, is used at any height: its maxPixels is Infinity, not ${value}`);
    if (this.index === 0) return;
    if (!(value > 0)) throw new Error(`Lod: maxPixels must be > 0, got ${value}`);
    this.explicit = value;
    resolve(this.ladder);
  }
}

/** Error a built level reports: how far its surface is from its source's, in the source's units. */
const errors = new WeakMap<Object3D, number>();

/** Record that `level` is `error` off its source (see `errors`). */
export const recordError = (level: Object3D, error: number): void => void errors.set(level, error);
/** The error recorded for `level`, if any. */
export const errorOf = (level: Object3D): number | undefined => errors.get(level);

/** Clones of `levels`' objects, which keep the errors recorded for them. */
export function cloneLevels(levels: readonly Level[]): Object3D[] {
  return levels.map(({ object }) => {
    const clone = object.clone();
    const error = errorOf(object);
    if (error !== undefined) errors.set(clone, error);
    return clone;
  });
}

/** Give `to` the maxPixels set on `from`, level by level. */
export function copyThresholds(from: readonly Level[], to: readonly Level[]): void {
  to.forEach((level, i) => {
    const explicit = from[i]?.explicit ?? null;
    if (explicit !== null) level.maxPixels = explicit;
  });
}

/**
 * Give each level its default `base`, for a source of bounding diameter `diameter` in its
 * own units, and resolve the thresholds (see `LodLevel.maxPixels`).
 */
export function estimate(levels: readonly Level[], diameter: number): void {
  let finer = 1024;
  for (const level of levels.slice(1)) {
    const error = errorOf(level.object);
    if (error !== undefined) level.base = diameter / Math.max(error, diameter * 1e-4);
    else if (isImpostorMesh(level.object)) level.base = texelPixels(level.object.impostor);
    else level.base = finer / 2;
    finer = level.base;
  }
  resolve(levels);
}

/** Each level's maxPixels: as set, else its base raised to twice the next level's, from the cheapest up. */
function resolve(levels: readonly Level[]): void {
  let next = 0;
  for (const level of [...levels].reverse()) {
    level.value = level.index === 0 ? Infinity : (level.explicit ?? Math.max(level.base, 2 * next));
    next = level.value;
  }
}

/** Throws unless each level's fade ends before the next one's begins (see `LodLevel.maxPixels`). */
export function validate(levels: readonly LodLevel[]): void {
  levels.forEach((level, i) => {
    const finer = levels[i - 1];
    if (finer && level.maxPixels > finer.maxPixels * (1 - FADE))
      throw new Error(
        `Lod: level ${i} has maxPixels ${level.maxPixels}, but at most ${finer.maxPixels * (1 - FADE)} (${1 - FADE} × level ${i - 1}'s ${finer.maxPixels}) leaves room for the fades`,
      );
  });
}

/** The level drawn at `height`: the last one it fits, or `forceLevel`. */
export function levelAt(levels: readonly Level[], height: number, forceLevel: number | null): Level {
  const level = levels[forceLevel ?? lastFitting(levels, height)];
  if (!level) throw new Error(`Lod: forceLevel ${forceLevel} is not a level`);
  return level;
}

function lastFitting(levels: readonly Level[], height: number): number {
  for (let i = levels.length - 1; i > 0; i--) {
    const level = levels[i];
    if (level && height <= level.maxPixels) return i;
  }
  return 0;
}

/**
 * How far `level` has faded in over its finer neighbour at `height`, in [0, 1): 0 when
 * no fade is under way (the finer level is gone). See fade.ts for how both draw it.
 */
export function fadeProgress(levels: readonly Level[], level: Level, height: number): number {
  const finer = levels[level.index - 1];
  if (!finer || level.nested || finer.nested) return 0;
  const top = level.maxPixels;
  const t = Math.min(Math.max((height - top * (1 - FADE)) / (top * FADE), 0), 1);
  // smoothstep, as the GPU's selection computes it
  return t * t * (3 - 2 * t);
}

/** Debug tints by level index, see `Lod.debug`. */
const TINTS = [0xff6060, 0x60ff60, 0x6080ff, 0xffd040, 0xff60ff, 0x60ffff].map((hex) => new Color(hex));

/** Give each level its debug tint, or white. */
export function tintLevels(levels: readonly Level[], debug: boolean): void {
  for (const level of levels) level.tint.set(debug ? (TINTS[level.index % TINTS.length] ?? 0xffffff) : 0xffffff);
}

import { Color, type Box3, type Object3D } from "three/webgpu";
import type { d } from "typegpu";
import { at } from "../at.js";
import { levelBox } from "./bounds.js";
import { texelPixels } from "../impostor/impostor.js";
import { isImpostorMesh } from "../three.js";
import { FADE, MAX_LEVELS, drawLevels, type DrawLevels } from "./draw.js";
import { LevelHeights } from "./load.js";

// The levels of a Lod: what one is, the checks a list of them passes, and their default thresholds.

/**
 * One level of a Lod: an object given, or one `load` makes when a camera first needs it, which `box` bounds meanwhile.
 * `lod.levels` holds the same shape, with `object` the Lod's own copy, once there is one: the template its level meshes
 * are made from, never in the scene.
 *
 * Objects you give or load are yours to dispose, as a three Mesh never disposes its geometry or material; a Lod frees
 * only what it made of them. CachedLodLoader's are freed when the last Lod holding them is disposed (see `hold`).
 */
export interface LodLevel {
  /** The level's object: yours to dispose. */
  object?: Object3D;
  /**
   * Makes the level's object, yours to dispose. A load shared across several Lods runs once per Lod; memoize it to
   * share one object.
   */
  load?: () => Promise<Object3D>;
  /** A deferred level's bounds in the Lod's space; empty for a level that draws nothing. */
  box?: Box3;
  /**
   * Largest on-screen height, in CSS pixels × Lod.quality, at which this level draws: Infinity for level 0, the finest;
   * every later one at most (1 - Lod.fade) of its finer neighbour's, which leaves room for the fades. A deferred level
   * needs one. A given level without one gets one measured from its surface deviation (see `simplify`, `bakeMesh`) or
   * its impostor's texels, else half its finer neighbour's (512 for level 1), raised to leave room for the fades;
   * `lod.levels` holds what it got.
   */
  maxPixels?: number;
  /**
   * Holds what the level's object comes from while a Lod draws it: every Lod made from the level, a copy or clone
   * included, calls each distinct `hold` once as it is made, and the release it answers once it is disposed. CachedLodLoader's
   * levels free what they loaded when the last release is called, which spends them: a Lod made from them later throws.
   * CachedLodLoader's levels no Lod ever holds are never freed: they are yours until a Lod holds them.
   */
  hold?: () => () => void;
}

/** A level with its threshold, as `lod.levels` holds it. */
export type ThresholdedLevel = LodLevel & { maxPixels: number };

/** Throws unless `levels` can be drawn: each given or deferred with a finite box, and thresholds as `LodLevel` says. */
export function checkLevels(levels: readonly ThresholdedLevel[], who: string): void {
  if (levels.length > MAX_LEVELS) throw new Error(`${who}: ${levels.length} levels, but at most ${MAX_LEVELS}`);
  levels.forEach(({ object, load, box }, i) => {
    if (!object && !load) throw new Error(`${who}: level ${i} has neither an object nor a load`);
    if (!object && !box) throw new Error(`${who}: deferred level ${i} needs a box`);
    if (box && !box.isEmpty() && ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite))
      throw new Error(`${who}: level ${i}'s box must be finite`);
  });
  checkThresholds(
    levels.map(({ maxPixels }) => maxPixels),
    who,
  );
}

/** Throws unless `thresholds` are maxPixels as `LodLevel` says. */
function checkThresholds(thresholds: readonly number[], who: string): void {
  thresholds.forEach((maxPixels, i) => {
    if (i === 0 && maxPixels !== Infinity) throw new Error(`${who}: level 0, the source, is used at any height: its maxPixels is Infinity, not ${maxPixels}`);
    if (!(maxPixels > 0)) throw new Error(`${who}: maxPixels must be > 0, got ${maxPixels}`);
    const finer = thresholds[i - 1];
    if (finer !== undefined && maxPixels > finer * (1 - FADE))
      throw new Error(
        `${who}: level ${i} has maxPixels ${maxPixels}, but at most ${finer * (1 - FADE)} (${1 - FADE} × level ${i - 1}'s ${finer}) leaves room for the fades`,
      );
  });
}

/**
 * `inputs` as `lod.levels` holds them: each object cloned, each threshold given or measured (see `LodLevel.maxPixels`)
 * for a source `diameter` across. Throws unless they can be drawn.
 */
export function levelsFrom(inputs: readonly LodLevel[], diameter: number, who: string): ThresholdedLevel[] {
  const thresholds = resolveThresholds(
    inputs.map(({ object, maxPixels }) => ({ maxPixels, measured: object && maxPixels === undefined ? measure(object) : undefined })),
    diameter,
    who,
  );
  const levels = inputs.map((input, i) => ({ ...input, object: input.object?.clone(), maxPixels: at(thresholds, i) }));
  checkLevels(levels, who);
  return levels;
}

/** The bits of the levels that draw nothing: an empty object or box. */
export function emptyLevels(levels: readonly LodLevel[]): number {
  return levels.reduce((bits, level, i) => (levelBox(level).isEmpty() ? bits | (1 << i) : bits), 0);
}

/** Debug tints by level index, see `Lod.debug`. */
const TINTS = [0xff6060, 0x60ff60, 0x6080ff, 0xffd040, 0xff60ff, 0x60ffff].map((hex) => new Color(hex));
const WHITE = new Color(1, 1, 1);

/** Level `index`'s debug tint, or white. */
export const tintOf = (index: number, debug: boolean): Color => (debug ? at(TINTS, index % TINTS.length) : WHITE);

/**
 * Per simplified or baked object, its deviation: a side table, as three's objects have no typed place for it (userData
 * is the app's).
 */
const deviations = new WeakMap<Object3D, number>();
/** Surface deviation from the source, in the source's units. */
export const recordDeviation = (level: Object3D, deviation: number): void => void deviations.set(level, deviation);
export const deviationOf = (level: Object3D): number | undefined => deviations.get(level);

/** What a level's default threshold is measured from: surface deviation, else impostor texels. */
interface Measured {
  deviation?: number;
  texels?: number;
}

export function measure(object: Object3D): Measured {
  return { deviation: deviationOf(object), texels: isImpostorMesh(object) ? texelPixels(object.impostor) : undefined };
}

/** A level to find a threshold for: its own maxPixels, else what it measured. */
interface Measurable {
  maxPixels?: number;
  measured?: Measured;
}

/**
 * Thresholds for `levels` of an object `diameter` across: each level's own maxPixels, else its measured surface
 * deviation's or impostor texels' height, else half the previous one (512 for level 1), raised where needed to leave
 * room for the fades. Throws if the result does not (see `checkLevels`).
 */
export function resolveThresholds(levels: readonly Measurable[], diameter: number, who: string): number[] {
  let finer = 1024;
  const defaults = levels.map(({ maxPixels, measured }, index) => {
    if (index === 0) return Infinity;
    const base = !measured
      ? maxPixels
      : measured.deviation !== undefined
        ? diameter / Math.max(measured.deviation, diameter * 1e-4)
        : (measured.texels ?? finer / 2);
    if (base === undefined) throw new Error(`${who}: deferred level ${index} needs maxPixels`);
    finer = base;
    return base;
  });
  const thresholds = levels.map(() => Infinity);
  let next = 0;
  for (let i = levels.length - 1; i > 0; i--) {
    const value = levels[i]?.maxPixels ?? Math.max(at(defaults, i), 2 * next);
    thresholds[i] = value;
    next = value;
  }
  thresholds[0] = levels[0]?.maxPixels ?? Infinity;
  checkThresholds(thresholds, who);
  return thresholds;
}

/**
 * Levels as levelsToDraw reads them, and what they draw at each height once asked: all loaded, and with the two sets of
 * loaded levels last asked for (an arrival's levels before and after).
 */
interface Encoding {
  readonly levels: d.Infer<typeof DrawLevels>;
  heights: LevelHeights | null;
  readonly loading: LevelHeights[];
}

/**
 * A Lod's levels as levelsToDraw reads them (see `drawLevels`), checked and encoded again only when a
 * threshold or the forced level has changed. What it returns is shared: read it, do not hold on to it.
 */
export class EncodedLevels {
  private thresholds: number[] = [];
  private forced: number | null = null;
  /** For cameras that fade levels and for those that do not. */
  private encoded: { fading: Encoding; still: Encoding };

  constructor(
    private readonly levels: readonly ThresholdedLevel[],
    /** The bits of the levels that draw nothing. */
    private readonly empty: number,
    private readonly who: string,
  ) {
    this.encoded = this.encode(null);
  }

  /** The levels with `forced` the forced level, for a camera that `fades` levels or not. Throws unless they can be drawn. */
  get(forced: number | null, fades: boolean): d.Infer<typeof DrawLevels> {
    let changed = forced !== this.forced;
    for (let i = 0; i < this.levels.length && !changed; i++) changed = this.levels[i]?.maxPixels !== this.thresholds[i];
    if (changed) this.encoded = this.encode(forced);
    return (fades ? this.encoded.fading : this.encoded.still).levels;
  }

  /**
   * What `levels`, as `get` gave them, draw at each height with the levels of `loaded` loaded, all by default (see
   * LevelHeights): worked out the first time it is asked, and anew with the levels.
   */
  heights(levels: d.Infer<typeof DrawLevels>, loaded = (1 << levels.count) - 1): LevelHeights {
    const { fading, still } = this.encoded;
    const encoding = levels === fading.levels ? fading : levels === still.levels ? still : null;
    if (!encoding) throw new Error(`${this.who}: heights of levels it did not encode, or no longer does`);
    if (loaded === (1 << levels.count) - 1) return (encoding.heights ??= new LevelHeights(levels));
    const { loading } = encoding;
    const found = loading.find((heights) => heights.loaded === loaded);
    if (found) return found;
    const made = new LevelHeights(levels, loaded);
    loading.unshift(made);
    loading.length = Math.min(loading.length, 2);
    return made;
  }

  private encode(forced: number | null) {
    const { levels, empty, who } = this;
    checkLevels(levels, who);
    if (forced !== null && !levels[forced]) throw new Error(`${who}: forceLevel ${forced} is not a level`);
    this.thresholds = levels.map(({ maxPixels }) => maxPixels);
    this.forced = forced;
    const encoding = (fades: boolean): Encoding => ({ levels: drawLevels(levels, empty, forced, fades), heights: null, loading: [] });
    return { fading: encoding(true), still: encoding(false) };
  }
}

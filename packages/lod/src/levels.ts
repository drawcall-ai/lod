import { Color, type Box3, type Object3D } from "three/webgpu";
import { texelPixels } from "./impostor/impostor.js";
import { isImpostorMesh, isLOD } from "./three.js";
import { at } from "./at.js";

/** Share of each level's range over which its finer neighbour fades out. */
export const FADE = 0.1;

/** A reusable level description. Deferred objects arrive already placed in the owner's space. */
export type LodLevel =
  { object: Object3D; maxPixels?: number; load?: never; box?: never } | { load: () => Promise<Object3D>; maxPixels: number; box: Box3; object?: never };

/** One level of an owner, as `Lod.levels` and `InstancedLod.levels` show it. */
export interface LevelView {
  /** Level 0 is the source. */
  readonly index: number;
  /**
   * The level's object, undefined until a deferred level has arrived. For a Lod it is
   * drawn, and its visibility is the Lod's switch. For an InstancedLod it is the template
   * the level's instanced meshes are made from: never in the scene, so `levelOf` tells
   * what draws.
   */
  readonly object: Object3D | undefined;
  /** A deferred level's bounds in the owner's space. */
  readonly box: Box3 | undefined;
  /**
   * Largest on-screen height, in CSS pixels × Lod.quality, at which this level draws.
   * Level 0 is Infinity. Every later threshold must be at most 0.9 of its predecessor.
   * Defaults use measured surface deviation, impostor texels, or half the previous
   * threshold (512 for level 1), raised where needed to leave room for fades.
   */
  maxPixels: number;
}

/** One owner's resolved threshold and drawable, separate from its reusable description. */
export class Level implements LevelView {
  readonly tint = new Color(1, 1, 1);
  readonly box: Box3 | undefined;
  object: Object3D | undefined;
  nested: boolean;
  explicit: number | null;
  base = Infinity;
  value = Infinity;

  constructor(
    readonly input: LodLevel,
    readonly index: number,
    private readonly ladder: readonly Level[],
  ) {
    this.explicit = input.maxPixels ?? null;
    if (input.maxPixels !== undefined) checkThreshold(input.maxPixels, index);
    this.box = input.box;
    if (this.box && !this.box.isEmpty() && ![...this.box.min.toArray(), ...this.box.max.toArray()].every(Number.isFinite))
      throw new Error("Lod: a deferred level's box must be finite");
    this.object = input.object?.clone();
    this.nested = this.object ? isLOD(this.object) : false;
  }

  get maxPixels(): number {
    return this.value;
  }
  set maxPixels(value: number) {
    checkThreshold(value, this.index);
    this.explicit = value;
    resolve(this.ladder);
  }
}

function checkThreshold(value: number, index: number): void {
  if (index === 0 && value !== Infinity) throw new Error(`Lod: level 0, the source, is used at any height: its maxPixels is Infinity, not ${value}`);
  if (!(value > 0)) throw new Error(`Lod: maxPixels must be > 0, got ${value}`);
}

const deviations = new WeakMap<Object3D, number>();
/** Surface deviation from the source, in the source's units. */
export const recordDeviation = (level: Object3D, deviation: number): void => void deviations.set(level, deviation);
export const deviationOf = (level: Object3D): number | undefined => deviations.get(level);

/** Descriptions for a new owner, retaining threshold edits and sharing deferred decode. */
export function cloneLevels(levels: readonly Level[]): LodLevel[] {
  return levels.map((level) => {
    const { input, explicit } = level;
    if (input.load) return { ...input, maxPixels: level.maxPixels };
    return { object: input.object, ...(explicit === null ? {} : { maxPixels: explicit }) };
  });
}

interface Threshold {
  index: number;
  explicit: number | null;
  base: number;
  value: number;
}

/** What a level's default threshold is measured from: surface deviation, else impostor texels. */
interface Measured {
  deviation?: number;
  texels?: number;
}

export function measure(object: Object3D): Measured {
  return { deviation: deviationOf(object), texels: isImpostorMesh(object) ? texelPixels(object.impostor) : undefined };
}

/** A level to resolve: `measured` is absent for a deferred level, whose own maxPixels stands in. */
interface Measurable {
  maxPixels?: number;
  measured?: Measured;
}

function bases(levels: readonly Measurable[], diameter: number): number[] {
  let finer = 1024;
  return levels.map(({ maxPixels, measured }, index) => {
    if (index === 0) return Infinity;
    const base = !measured
      ? maxPixels
      : measured.deviation !== undefined
        ? diameter / Math.max(measured.deviation, diameter * 1e-4)
        : (measured.texels ?? finer / 2);
    if (base === undefined) throw new Error("Lod: a deferred level needs maxPixels");
    finer = base;
    return base;
  });
}

/** Resolve thresholds from measurements without constructing renderer state. */
export function resolveThresholds(levels: readonly Measurable[], diameter: number): number[] {
  const defaults = bases(levels, diameter);
  const thresholds = levels.map((level, index) => {
    if (level.maxPixels !== undefined) checkThreshold(level.maxPixels, index);
    return { index, explicit: level.maxPixels ?? null, base: defaults[index] ?? Infinity, value: Infinity };
  });
  resolve(thresholds);
  validate(thresholds.map(({ value }) => ({ maxPixels: value })));
  return thresholds.map(({ value }) => value);
}

/** Resolve defaults once, retaining writable owner thresholds. */
export function estimate(levels: readonly Level[], diameter: number): void {
  const defaults = bases(
    levels.map(({ input }) => ({ maxPixels: input.maxPixels, measured: input.object && measure(input.object) })),
    diameter,
  );
  levels.forEach((level, index) => {
    level.base = defaults[index] ?? Infinity;
  });
  resolve(levels);
}

function resolve(levels: readonly Threshold[]): void {
  let next = 0;
  for (let i = levels.length - 1; i >= 0; i--) {
    const level = at(levels, i);
    level.value = level.index === 0 ? Infinity : (level.explicit ?? Math.max(level.base, 2 * next));
    next = level.value;
  }
}

/** Throws when neighbouring fades overlap. */
export function validate(levels: readonly { maxPixels: number }[]): void {
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

/** The coarsest level whose maxPixels `height` still fits; level 0 fits any height. */
export function lastFitting(levels: readonly { maxPixels: number }[], height: number): number {
  for (let i = levels.length - 1; i > 0; i--) if (height <= at(levels, i).maxPixels) return i;
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

// Start refinement 20% below its lower fade bound, leaving time for decode and GPU preparation.
export const DEMAND = 0.8;

/** Logical demand and the next finer fade partner, including a small approach margin. */
export function demandLevels(levels: readonly Level[], height: number, forced: number | null): Level[] {
  const desired = levelAt(levels, height, forced);
  if (forced !== null) return [desired];
  const finer = levels[desired.index - 1];
  return finer && height >= DEMAND * desired.maxPixels * (1 - FADE) ? [desired, finer] : [desired];
}

/** Nearest ready finer level, else nearest coarser; -1 draws nothing until one is ready. */
export function fallbacks(levels: readonly Level[], ready: ReadonlySet<Level>): number[] {
  return levels.map((_, index) => {
    for (let finer = index; finer >= 0; finer--) if (ready.has(at(levels, finer))) return finer;
    for (let coarser = index + 1; coarser < levels.length; coarser++) if (ready.has(at(levels, coarser))) return coarser;
    return -1;
  });
}

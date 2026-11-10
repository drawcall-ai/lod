import type { d } from "typegpu";
import { at } from "../at.js";
import { ANY_HEIGHT, FADE, levelsToDraw, type Draw, type DrawLevels } from "./draw.js";

// Which levels a camera needs loaded, and which it can draw.

/**
 * The bits of the levels to load for objects whose heights on a camera's screen lie in `ranges` (shortest and tallest,
 * in px), read from `heights`, all levels loaded: every level a height in a range draws once all are loaded, the finer
 * neighbour inside a fade included, and with any that draws something the coarsest level that draws something, which
 * every draw waits for (see levelsToDraw). None where nothing draws.
 */
export function levelsToLoad(ranges: Iterable<readonly [shortest: number, tallest: number]>, heights: LevelHeights): number {
  const { count, empty, coarsest } = heights.levels;
  const all = (1 << count) - 1;
  let wanted = 0;
  for (const [shortest, tallest] of ranges) {
    wanted |= heights.drawnIn(shortest, tallest);
    // Every level that draws something is wanted already.
    if ((wanted & ~empty) === (all & ~empty)) break;
  }
  return wanted & ~empty ? wanted | (1 << coarsest) : wanted;
}

/**
 * How far, in f32 steps, a height where what levelsToDraw draws changes may lie from where `windowsOf` puts it: on the
 * CPU, TypeGPU rounds heights and maxPixels to f32 and computes a fade's start from them, which moves it by a step.
 */
const SLACK = 4;

/**
 * The levels levelsToDraw draws with `levels` and the levels of `loaded` loaded, no arrival under way, at every height,
 * by intervals of heights: worked out once, as it walks every chunk's heights each frame and each of its CPU calls
 * through TypeGPU copies its arguments. What it draws changes only at a level's maxPixels and where its fade starts,
 * whatever is loaded (which only says what stands in for a level): it is asked at the ends of a few f32 steps around
 * each such height, and between them where it changes. levelsToDraw stays the only answer; this is where it changes.
 */
export class LevelHeights {
  /** The last f32 height of every interval but the last, ascending. */
  private readonly ends: number[] = [];
  /** The bits of the levels each interval draws: its level, and inside a fade the finer one too. */
  private readonly drawn: number[] = [];

  constructor(
    readonly levels: d.Infer<typeof DrawLevels>,
    readonly loaded = (1 << levels.count) - 1,
  ) {
    const ask = (height: number): number => drawnBits(levelsToDraw(height, levels, loaded, loaded, 1));
    let below = ask(0);
    this.drawn.push(below);
    for (const [low, high] of windowsOf(levels)) {
      if (ask(low) !== below) throw new Error("Lod: levelsToDraw changes away from every maxPixels and fade start");
      const above = ask(high);
      // Every change inside the window: the last f32 height that draws what is below it, found by halving.
      for (let from = low; below !== above;) {
        let last = from;
        let past = high;
        while (step(last, 1) < past) {
          const middle = halfway(last, past);
          if (ask(middle) === below) last = middle;
          else past = middle;
        }
        below = ask(past);
        this.ends.push(last);
        this.drawn.push(below);
        from = past;
      }
    }
    // levelsToDraw takes no infinite f32: the largest finite one stands for every height above.
    if (ask(ANY_HEIGHT) !== below) throw new Error("Lod: levelsToDraw changes above every maxPixels");
  }

  /** The bits of the levels objects from `shortest` to `tallest` px tall draw. */
  drawnIn(shortest: number, tallest: number): number {
    const last = this.interval(tallest);
    let bits = 0;
    for (let i = this.interval(shortest); i <= last; i++) bits |= at(this.drawn, i);
    return bits;
  }

  /** The interval holding `height`. */
  private interval(height: number): number {
    // levelsToDraw reads a height as an f32.
    const value = Math.fround(height);
    const { ends } = this;
    let index = 0;
    let end = ends.length;
    while (index < end) {
      const middle = (index + end) >>> 1;
      if (value > at(ends, middle)) index = middle + 1;
      else end = middle;
    }
    return index;
  }
}

/** The bits of the levels `draw` draws: its level, and its finer one while it fades; none for level -1. */
export function drawnBits({ level, finer, fade }: d.Infer<typeof Draw>): number {
  if (level < 0) return 0;
  return (1 << level) | (fade > 0 ? 1 << finer : 0);
}

/**
 * The f32 heights around which what levelsToDraw draws with `levels` may change, `SLACK` steps either side, ascending
 * and merged where they overlap: every level's maxPixels but the source's, and where its fade starts.
 */
function windowsOf(levels: d.Infer<typeof DrawLevels>): [low: number, high: number][] {
  const edges: number[] = [];
  levels.maxPixels.forEach((maxPixels, level) => {
    if (level === 0 || level >= levels.count) return;
    edges.push(Math.fround(maxPixels), Math.fround(Math.fround(maxPixels) * (1 - FADE)));
  });
  edges.sort((a, b) => a - b);
  const windows: [number, number][] = [];
  for (const edge of edges) {
    const low = step(edge, -SLACK);
    const last = windows.at(-1);
    if (last && low <= last[1]) last[1] = step(edge, SLACK);
    else windows.push([low, step(edge, SLACK)]);
  }
  return windows;
}

const float = new Float32Array(1);
const bits = new Uint32Array(float.buffer);

/** The f32 `steps` steps from `value`, a height at or above 0, not below 0. */
function step(value: number, steps: number): number {
  float[0] = value;
  bits[0] = Math.max(at(bits, 0) + steps, 0);
  return at(float, 0);
}

/** An f32 between the f32s `low` and `high`, two or more steps apart, at or above 0. */
function halfway(low: number, high: number): number {
  float[0] = low;
  const from = at(bits, 0);
  float[0] = high;
  bits[0] = from + Math.floor((at(bits, 0) - from) / 2);
  return at(float, 0);
}

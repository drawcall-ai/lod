import type { Camera } from "three/webgpu";

/**
 * How far an InstancedLod's instances reach from one camera, thinning out over a ramp before it. An instance with keep
 * ratio k draws, in every view, iff k < `keptFraction(d, range)`, d its distance from `camera`: the same instances
 * in a view and in its shadow maps, nested subsets as d grows, none half transparent.
 */
export interface InstancedRange {
  /** The camera distances are measured from in every view: the main one, also for shadow maps and other views. */
  camera: Camera;
  /** World distance at which no instance draws. */
  radius: number;
  /** World distance before `radius` over which instances thin out, > 0. */
  ramp: number;
  /**
   * Scale each instance that draws by 1 / √keptFraction(d) about its origin, keeping the coverage of a thinning crowd
   * such as grass; at most `MAX_SURVIVOR_SCALE` times.
   */
  scaleSurvivors?: boolean;
}

/** The fraction of instances `range` keeps at world distance `distance` from its camera. */
export function keptFraction(distance: number, range: Pick<InstancedRange, "radius" | "ramp">): number {
  return Math.min(Math.max((range.radius - distance) / range.ramp, 0), 1);
}

/** The largest a survivor scales: the scale at kept fraction 1/64, which only instances with keep ratios below it reach. */
export const MAX_SURVIVOR_SCALE = 8;

/** The scale of a survivor where `fraction` of the instances are kept, as the selection applies it. */
export const survivorScale = (fraction: number): number => Math.min(1 / Math.sqrt(fraction), MAX_SURVIVOR_SCALE);

/** Throws unless `range` is a valid range. */
export function checkRange(range: InstancedRange): void {
  if (!(range.radius >= 0) || !Number.isFinite(range.radius)) throw new RangeError(`InstancedLod: range radius must be finite and >= 0, got ${range.radius}`);
  if (!(range.ramp > 0) || !Number.isFinite(range.ramp)) throw new RangeError(`InstancedLod: range ramp must be finite and > 0, got ${range.ramp}`);
}

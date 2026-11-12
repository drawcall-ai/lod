import { Matrix4, type Camera, type Vector3 } from "three/webgpu";
import type { d } from "typegpu";
import type { EncodedLevels } from "../levels/index.js";
import type { DrawLevels } from "../levels/draw.js";
import { screenOf } from "../levels/screen.js";

// What a Lod works out per camera on the CPU: the camera in its space, and the levels whose meshes draw.

/** A camera in a Lod's space (see `localCamera`). */
export interface LocalCamera {
  levels: d.Infer<typeof DrawLevels>;
  eye: Vector3;
  /** Pixels per unit of subtense (or of size, orthographic). */
  scale: number;
  ortho: boolean;
}

/** The level loading state levelsToDraw reads (see LodLevelLoadManager). */
export interface Loading {
  loaded: number;
  before: number;
  progress: number;
}

/** How much wider than ClusterView gives them the heights a level mesh is shown for are, relatively. */
const SLACK = 1e-4;

const inverse = new Matrix4();

/**
 * `camera`, drawing into a target `height` pixels tall (see screenOf), in the space of `space`, a Lod's world matrix:
 * the levels of `encoded` as levelsToDraw reads them for it, `forced` drawn alone if not null, where it looks from and
 * its pixels per unit, `quality` times what it measures.
 */
export function localCamera(camera: Camera, height: number, space: Matrix4, encoded: EncodedLevels, forced: number | null, quality: number): LocalCamera {
  const screen = screenOf(camera, height);
  // Checked before anything reads the thresholds.
  const levels = encoded.get(forced, !screen.ortho);
  const eye = screen.eye.applyMatrix4(inverse.copy(space).invert());
  // Heights are measured in the Lod's space: an orthographic camera's size scales with it.
  const scale = screen.scale * quality * (screen.ortho ? space.getMaxScaleOnAxis() : 1);
  return { levels, eye, scale, ortho: screen.ortho };
}

/**
 * The levels whose meshes draw for a camera seeing instances of the heights `seen`, with what is loaded: those
 * levelsToDraw draws at such a height with the levels of `loaded`, and while an arrival is under way those of `before`
 * too, as levelsToDraw draws only what one or the other draws until the arrival ends; and `only`, the bit of the one
 * level they all draw without a fade while no arrival is under way, else 0.
 */
export function shownBy(seen: readonly (readonly [number, number])[], levels: LocalCamera["levels"], encoded: EncodedLevels, { loaded, before, progress }: Loading) {
  const arriving = progress < 1 && before !== loaded;
  const now = encoded.heights(levels, loaded);
  const then = arriving ? encoded.heights(levels, before) : null;
  let shown = 0;
  // What every range draws.
  let common = seen.length > 0 ? ~0 : 0;
  for (const [shortest, tallest] of seen) {
    // The GPU measures an instance's height in f32: a range a little wider holds every height it gets.
    const low = shortest * (1 - SLACK);
    const high = tallest * (1 + SLACK);
    const drawn = now.drawnIn(low, high) | (then?.drawnIn(low, high) ?? 0);
    shown |= drawn;
    common &= drawn;
  }
  // One level alone: drawnIn holds a fading level's finer neighbour too.
  const only = !arriving && common === shown && (shown & (shown - 1)) === 0 ? shown : 0;
  return { shown, only };
}

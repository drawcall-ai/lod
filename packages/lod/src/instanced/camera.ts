import { Matrix4, type Camera, type Vector3 } from "three/webgpu";
import type { d } from "typegpu";
import type { EncodedLevels } from "../levels/index.js";
import type { DrawLevels } from "../levels/draw.js";
import { levelsToLoad } from "../levels/load.js";
import { screenOf } from "../levels/screen.js";
import { Lod } from "../lod.js";
import type { ChunkSet } from "./chunks.js";
import type { Cull } from "./cull.js";
import type { CameraLists } from "./lists.js";
import type { InstanceShape } from "./shape.js";

// What an InstancedLod works out per camera on the CPU, each part only once what it reads changed: the camera in its
// space, the heights its chunks' instances can have on the camera's screen with the levels to load for them, and the
// levels whose meshes draw.

/** A camera in an InstancedLod's space (see `localCamera`). */
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

/** How much wider than ChunkSet.heights gives them the heights a level mesh is shown for are, relatively. */
const SLACK = 1e-4;

const inverse = new Matrix4();

/**
 * `camera`, drawing into a target `height` pixels tall (see screenOf), in the space of `space`, an InstancedLod's world matrix: the
 * levels of `encoded` as levelsToDraw reads them for it, `forced` drawn alone if not null, where it looks from and its
 * pixels per unit.
 */
export function localCamera(camera: Camera, height: number, space: Matrix4, encoded: EncodedLevels, forced: number | null): LocalCamera {
  const screen = screenOf(camera, height);
  // Checked before anything reads the thresholds.
  const levels = encoded.get(forced, !screen.ortho);
  const eye = screen.eye.applyMatrix4(inverse.copy(space).invert());
  // Heights are measured in the InstancedLod's space: an orthographic camera's size scales with it.
  const scale = screen.scale * Lod.quality * (screen.ortho ? space.getMaxScaleOnAxis() : 1);
  return { levels, eye, scale, ortho: screen.ortho };
}

/**
 * Work out into `found`, a camera's lists, the heights `chunks`' instances can have on its screen and the levels it
 * needs loaded for them, in one walk of the chunks, only once what that reads changed.
 */
export function walk(
  found: CameraLists,
  { levels, eye, scale, ortho, cull }: LocalCamera & { cull: Cull | null },
  { chunks, shape, encoded }: { chunks: ChunkSet; shape: InstanceShape; encoded: EncodedLevels },
): void {
  const key = found.heightsKey.start();
  // An orthographic camera measures heights alike from anywhere.
  if (!ortho) key.put(eye.x).put(eye.y).put(eye.z);
  if (!key.screen(scale, ortho, levels, cull, shape.source).put(chunks.version).end()) return;
  found.heights = Array.from(chunks.heights(shape.source, eye, scale, ortho, cull));
  found.wanted = levelsToLoad(found.heights, encoded.heights(levels));
  found.heightsVersion++;
}

/**
 * The levels whose meshes draw for the camera of `found` with what is loaded: those levelsToDraw draws at a height
 * some chunk's instances can have, with the levels of `loaded`, and while an arrival is under way those of `before`
 * too, as levelsToDraw draws only what one or the other draws until the arrival ends. Sets `found.onlyLevel` too.
 * Worked out again only once what that reads changed.
 */
export function shownBy(found: CameraLists, levels: LocalCamera["levels"], encoded: EncodedLevels, { loaded, before, progress }: Loading): number {
  const arriving = progress < 1 && before !== loaded;
  if (
    !found.shownKey
      .start()
      .put(found.heightsVersion)
      .put(loaded)
      .put(arriving ? before : loaded)
      .end()
  )
    return found.shown;
  const now = encoded.heights(levels, loaded);
  const then = arriving ? encoded.heights(levels, before) : null;
  let shown = 0;
  // What every chunk draws.
  let common = found.heights.length > 0 ? ~0 : 0;
  for (const [shortest, tallest] of found.heights) {
    // The GPU measures an instance's height in f32: a range a little wider holds every height it gets.
    const low = shortest * (1 - SLACK);
    const high = tallest * (1 + SLACK);
    const drawn = now.drawnIn(low, high) | (then?.drawnIn(low, high) ?? 0);
    shown |= drawn;
    common &= drawn;
  }
  found.shown = shown;
  // One level alone: drawnIn holds a fading level's finer neighbour too.
  found.onlyLevel = !arriving && common === shown && (shown & (shown - 1)) === 0 ? shown : 0;
  return shown;
}

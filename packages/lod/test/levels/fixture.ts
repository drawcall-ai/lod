import { Box3, type LoadingManager } from "three/webgpu";
import { vi } from "vitest";
import { box } from "../box.js";

// What the tests of a Lod's loading share: the skill's wait for a LoadingManager, and a level whose load waits.

/**
 * The skill's wait for `manager`: `draw`, wait a frame, and while it is loading, `compile`, `draw` and wait a frame
 * again. Throws once an item fails.
 */
export async function waitUntilIdle(manager: LoadingManager, draw: () => void, compile?: () => Promise<unknown>): Promise<void> {
  let loading = false;
  let failed: string | undefined;
  manager.onStart = () => (loading = true);
  manager.onLoad = () => (loading = false);
  manager.onError = (url) => (failed = url);
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  draw();
  await frame();
  while (loading && !failed) {
    await compile?.();
    draw();
    await frame();
  }
  if (failed) throw new Error(`${failed} failed`);
}

/** A deferred box whose load finishes only once `release` is called. */
export function gatedBox() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const load = vi.fn(async () => {
    await gate;
    return box();
  });
  return { level: { load, maxPixels: Infinity, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) }, load, release };
}

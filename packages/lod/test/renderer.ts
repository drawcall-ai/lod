import { RenderTarget, Scene, WebGPURenderer, type Camera, type Object3D } from "three/webgpu";
import { vi } from "vitest";
import type { Lod } from "../src/lod.js";
import { createBakeRenderer, readBytes } from "../src/bake.js";
import { rootOf } from "../src/three.js";

/** A WebGPU renderer in the test browser, initialised, its canvas 64 px on the page. */
export const renderer = new WebGPURenderer({ antialias: false });
renderer.setSize(64, 64);
renderer.setClearColor(0x000000, 0);
document.body.append(renderer.domElement);
await renderer.init();

/**
 * Render the scene holding `lod` (one of its own for the call, if it is in none) to the canvas from `camera`: three
 * updates it there. Its first render binds it to the renderer and draws nothing of it.
 */
export function renderLod(lod: Lod, camera: Camera): void {
  const root = rootOf(lod);
  const scene = root === lod ? new Scene().add(lod) : root;
  renderer.render(scene, camera);
  if (root === lod) scene.remove(lod);
}

/** A renderer for bakes, as CachedLodLoader makes one: its canvas, unlike `renderer`'s, is no square a bake frame may match. */
export const bakeRenderer = await createBakeRenderer();

/** Time for tests that bake or render: slow on a software adapter or a busy machine. */
export const GPU_TIMEOUT = 120_000;

/**
 * Retry `check` every `interval` ms until it passes, bounded only by the test timeout, GPU_TIMEOUT: on a busy machine
 * a tighter wall-clock bound flakes.
 */
export const eventually = <T>(check: () => T | Promise<T>, interval = 50): Promise<T> => vi.waitFor(check, { timeout: GPU_TIMEOUT, interval });

/** `scene` from `camera` on a `size` px square target, cleared transparent: RGBA bytes, rows bottom-up. */
export async function render(scene: Scene, camera: Camera, size = 64): Promise<Uint8Array> {
  const target = new RenderTarget(size, size);
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  const pixels = await readBytes(renderer, target, 0);
  target.dispose();
  return pixels;
}

/** Render the scene holding this lod each frame until the lod reports the actual installation. */
export function nextLevel(lod: Lod, camera: Camera): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame = 0;
    const clear = () => {
      cancelAnimationFrame(frame);
      lod.removeEventListener("levelschange", changed);
      lod.removeEventListener("levelserror", failed);
    };
    const changed = () => {
      clear();
      resolve();
    };
    const failed = ({ error }: { error: unknown }) => {
      clear();
      reject(error);
    };
    const scene: Object3D = rootOf(lod);
    const update = () => {
      renderer.render(scene, camera);
      frame = requestAnimationFrame(update);
    };
    lod.addEventListener("levelschange", changed);
    lod.addEventListener("levelserror", failed);
    frame = requestAnimationFrame(update);
  });
}

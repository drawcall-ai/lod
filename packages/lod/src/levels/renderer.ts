import type { Object3D, Renderer } from "three/webgpu";
import { isScene, isShadowPass } from "../three.js";

// What a Lod learns of the renderer drawing it, and when. three r186 shows much of it through no public API: each
// read of one of its private fields below says why none serves.

/**
 * How deep in renders `renderer` is: -1 outside them, 0 in a render of its own, 1 in one it draws inside another, as it
 * draws shadow maps and post-processing. Read from r186's `_callDepth`: three keeps a draw's built shader per depth,
 * and no public API tells which.
 */
export function callDepth(renderer: Renderer): number {
  const depth: unknown = Reflect.get(renderer, "_callDepth");
  if (typeof depth !== "number") throw new Error("Lod: three's renderer keeps no call depth (lod mirrors three r186)");
  return depth;
}

/**
 * Whether `renderer` is rendering or compiling now, as it is while it updates what it draws; not while an app calls
 * `update` itself or another renderer draws. A compile is told by r186's `_compilationPromises`, which no public API
 * shows.
 */
export const busy = (renderer: Renderer): boolean => callDepth(renderer) >= 0 || Reflect.get(renderer, "_compilationPromises") != null;

/**
 * Throws unless `renderer` can draw a Lod, `who`: three's WebGPU backend, whose device has indirect-first-instance, as
 * each level's draws start at its list (see update.ts).
 */
export function checkRenderer(renderer: Renderer, who: string): void {
  if (Reflect.get(renderer.backend, "isWebGPUBackend") !== true)
    throw new Error(`${who}: draws with WebGPU only, but its renderer runs another backend (WebGPURenderer falls back to WebGL2 where WebGPU is missing)`);
  if (!renderer.hasFeature("indirect-first-instance")) throw new Error(`${who}: needs the GPU feature indirect-first-instance, which this device lacks`);
}

/** The largest storage binding `renderer`'s device takes: r186's WebGPU backend's `device`, which three's types omit. */
export function maxStorageBinding(renderer: Renderer): number {
  const device: unknown = Reflect.get(renderer.backend, "device");
  const limits: unknown = typeof device === "object" && device !== null ? Reflect.get(device, "limits") : null;
  const size: unknown = typeof limits === "object" && limits !== null ? Reflect.get(limits, "maxStorageBufferBindingSize") : null;
  if (typeof size !== "number") throw new Error("Lod: its renderer has no WebGPU device (lod mirrors three r186)");
  return size;
}

/**
 * Whether the scene `node` is in is being drawn into a shadow map: three's shadow map render
 * draws it with its own override material, and calls `update` on every LOD with the
 * light's camera, which must not switch the levels the scene's camera chose.
 */
export function inShadowMap(node: Object3D): boolean {
  for (let scene: Object3D | null = node; scene; scene = scene.parent) if (isScene(scene) && isShadowPass(scene.overrideMaterial)) return true;
  return false;
}

/**
 * Whether `target` is the framebuffer target r186 draws the canvas (or output target) through when tone mapping or
 * the output colour space needs a final pass. A draw meant for the output sees it as the active target; a compile for
 * the output leaves the target unset and lets three resolve it.
 */
export const isOutputPass = (target: unknown): boolean =>
  typeof target === "object" && target !== null && Reflect.get(target, "isPostProcessingRenderTarget") === true;

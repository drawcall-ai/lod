import type { LoadingManager, Object3D, Renderer } from "three/webgpu";
import { isLOD, isScene, isShadowPass } from "../three.js";

// What a Lod learns of the renderer drawing it, and when. three r186 shows much of it through no public API: each
// read of one of its private fields below says why none serves.

/** A Lod or an InstancedLod: what has a LoadingManager, which items for its levels go to. */
export const hasLoadingManager = (node: Object3D): node is Object3D & { readonly manager: LoadingManager } =>
  isLOD(node) && "manager" in node && isLoadingManager(node.manager);
const isLoadingManager = (value: unknown): value is LoadingManager => typeof value === "object" && value !== null && "itemStart" in value && "itemEnd" in value;

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

/** The renderers Lods and InstancedLods may draw with (see `Lod.renderers`). */
export const renderers = new Set<Renderer>();

/**
 * The renderer of `renderers` rendering now, else the one compiling: three's renderer calls a LOD's `update` with its
 * camera only. Several at once throw, as which one updates the LOD is unknown.
 */
export function renderingNow(): Renderer | undefined {
  const busied = [...renderers].filter(busy);
  const rendering = busied.filter((renderer) => callDepth(renderer) >= 0);
  const found = rendering.length > 0 ? rendering : busied;
  if (found.length > 1) throw new Error("Lod: several of Lod.renderers render or compile at once: which one updates it is unknown");
  return found[0];
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

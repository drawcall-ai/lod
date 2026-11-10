import type { Camera, Material, Renderer, Scene } from "three/webgpu";
import { callDepth, inShadowMap, isOutputPass } from "../renderer.js";

// Where cameras render: what a level arriving for a camera is compiled for.

export interface RenderContext {
  camera: Camera;
  scene: Scene;
  /** The target the render was asked for: null for the output, also while three draws it through its output pass. */
  target: ReturnType<Renderer["getRenderTarget"]>;
  mrt: Parameters<Renderer["setMRT"]>[0];
  cubeFace: number;
  mipLevel: number;
  /** How deep in renders it drew (see `callDepth`). */
  depth: number;
}

/** A render target a camera or shadow map draws into. */
export type Target = NonNullable<RenderContext["target"]>;

/** A shadow map rendered for a scene, with the camera and override material three drew it with. */
export interface ShadowMap {
  camera: Camera;
  scene: Scene;
  target: Target;
  overrideMaterial: Material;
  depth: number;
}

/** What `renderer` rendering `scene` with `camera` is now: a camera's render context, or a shadow map. */
export function renderNow(renderer: Renderer, scene: Scene, camera: Camera): { context: RenderContext } | { shadow: ShadowMap } | null {
  const active = renderer.getRenderTarget();
  // A compile, outside renders, prepares draws at depth 0.
  const depth = Math.max(callDepth(renderer), 0);
  if (inShadowMap(scene)) {
    const material = scene.overrideMaterial;
    return active && material ? { shadow: { camera, scene, target: active, overrideMaterial: material, depth } } : null;
  }
  const target = isOutputPass(active) ? null : active;
  const cubeFace = renderer.getActiveCubeFace();
  const mipLevel = renderer.getActiveMipmapLevel();
  return { context: { camera, scene, target, mrt: renderer.getMRT(), cubeFace, mipLevel, depth } };
}

/** Whether `a` and `b` describe the same render: what was compiled for one is compiled for the other. */
export const sameContext = (a: RenderContext, b: RenderContext): boolean =>
  a.scene === b.scene && a.target === b.target && a.mrt === b.mrt && a.cubeFace === b.cubeFace && a.mipLevel === b.mipLevel && a.depth === b.depth;

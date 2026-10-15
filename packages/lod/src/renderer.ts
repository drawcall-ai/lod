import { Color, WebGLRenderer, type WebGLRenderTarget } from "three";

// The GPU side of bakes: impostor frames and interior rooms render here.

let shared: WebGLRenderer | undefined;

/** The package's own renderer for bakes: one WebGL context, since browsers cap them at about 16. */
export function sharedRenderer(): WebGLRenderer {
  shared ??= new WebGLRenderer({ antialias: false });
  return shared;
}

/**
 * Point the renderer at `target`, without the app's XR camera or clipping planes, and
 * return a function that puts the app's state back. A bake holds a shared renderer for
 * one render and read only: the app keeps rendering while the bake yields.
 */
export function borrow(renderer: WebGLRenderer, target: WebGLRenderTarget): () => void {
  const previous = {
    target: renderer.getRenderTarget(),
    clear: renderer.getClearColor(new Color()),
    alpha: renderer.getClearAlpha(),
    autoClear: renderer.autoClear,
    xr: renderer.xr.enabled,
    planes: renderer.clippingPlanes,
    local: renderer.localClippingEnabled,
  };
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  renderer.xr.enabled = false;
  renderer.clippingPlanes = [];
  renderer.localClippingEnabled = false;
  return () => {
    renderer.setRenderTarget(previous.target);
    renderer.setClearColor(previous.clear, previous.alpha);
    renderer.autoClear = previous.autoClear;
    renderer.xr.enabled = previous.xr;
    renderer.clippingPlanes = previous.planes;
    renderer.localClippingEnabled = previous.local;
  };
}

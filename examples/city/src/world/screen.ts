import type * as THREE from "three/webgpu";

// How large things look on screen, measured as the package measures levels: in CSS pixels of a screen `height` tall.

/** The on-screen size, in pixels, of a thing one metre across seen from one metre away by `camera`, times `quality`. */
export function screenScale(camera: THREE.Camera, height: number, quality: number): number {
  return (camera.projectionMatrix.elements[5] * height * quality) / 2;
}

/** The distance within which a thing `size` metres across (its bounding diameter) stands taller than `pixels` on screen. */
export function reachFor(camera: THREE.Camera, size: number, pixels: number, height: number, quality: number): number {
  return (size * screenScale(camera, height, quality)) / pixels;
}

import { Vector3, type Camera, type Matrix4, type Sphere } from "three/webgpu";

// How tall things are on a camera's screen.

/** How a camera measures heights: from where, and pixels per unit of subtense (perspective) or of size (orthographic). */
export interface Screen {
  readonly eye: Vector3;
  ortho: boolean;
  scale: number;
}

/** `camera`'s screen at `height`, the one it draws at, into `out`. */
export function screenOf(camera: Camera, height: number, out: Screen = { eye: new Vector3(), ortho: false, scale: 0 }): Screen {
  const projection = camera.projectionMatrix.elements;
  out.ortho = projection[15] === 1;
  out.scale = ((projection[5] ?? 0) * height) / 2;
  out.eye.setFromMatrixPosition(camera.matrixWorld);
  return out;
}

const centre = new Vector3();

/**
 * The height on `screen` of `sphere`, given in the space `root` maps to world: its diameter, scaled by the largest axis
 * scale of `root`, over its distance (small-angle), or its diameter alone in an orthographic camera.
 */
export function screenHeight(sphere: Sphere, root: Matrix4, screen: Screen): number {
  const size = 2 * sphere.radius * root.getMaxScaleOnAxis();
  if (screen.ortho) return size * screen.scale;
  return (size * screen.scale) / Math.max(screen.eye.distanceTo(centre.copy(sphere.center).applyMatrix4(root)), 1e-6);
}

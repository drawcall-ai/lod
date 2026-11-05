import { Matrix4, type Camera, type Frustum, type Vector3 } from "three/webgpu";
import type { View } from "../view.js";

/** A view as a crowd's blocks see it, in the crowd's space. */
export interface BlockView {
  eye: Vector3;
  /** pixels per unit of subtense (perspective) or of size (orthographic), × Lod.quality */
  scale: number;
  ortho: boolean;
  fades: boolean;
  forced: number | null;
}

const inverse = new Matrix4();

/** `camera`'s `view` as the instances of a crowd placed by `matrixWorld` see it, written into `out`. */
export function sight(out: Aim, view: View, camera: Camera, matrixWorld: Matrix4, quality: number, forced: number | null): Aim {
  inverse.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(matrixWorld);
  out.frustum.setFromProjectionMatrix(inverse, camera.coordinateSystem, camera.reversedDepth);
  out.eye.copy(view.eye).applyMatrix4(inverse.copy(matrixWorld).invert());
  out.scale = view.scale * quality * (view.ortho ? matrixWorld.getMaxScaleOnAxis() : 1);
  out.ortho = view.ortho;
  out.fades = view.fades;
  out.forced = forced;
  return out;
}

/** What a view selects with: see `Selection.aim`. */
export interface Aim extends BlockView {
  /** the view's frustum in the crowd's space */
  frustum: Frustum;
}

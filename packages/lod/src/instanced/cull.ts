import { Matrix4, Vector3, type Camera } from "three/webgpu";

/**
 * How a Lod thins its instances out with distance from `camera`, in every camera, as Fog does: every instance
 * draws up to `near` from it, none from `far` on, and in between a share falling linearly, chosen by a hash of each
 * instance's origin (its matrix's translation), the same on the CPU and the GPU. An instance whose translation changes
 * rolls a new value: it may appear or vanish as it moves. With `scaleSurvivors`, the instances drawn grow by 1/√share,
 * up to `MAX_SURVIVOR_SCALE` (8), so a thinned field stays about as covered.
 */
export interface CullDistance {
  camera: Camera;
  near: number;
  far: number;
  scaleSurvivors?: boolean;
}

/** cullDistance in the Lod's space. */
export interface Cull {
  eye: Vector3;
  near: number;
  far: number;
  survivors: boolean;
}

const inverse = new Matrix4();

/**
 * `cullDistance`, checked, in the space of `space`, a Lod's world matrix, written into `target`; null for
 * none. Nothing holds on to what it answers past a sort: the sort and its keys copy its values.
 */
export function cullIn(cullDistance: CullDistance | null, space: Matrix4, target: Cull): Cull | null {
  if (!cullDistance) return null;
  const { camera, near, far, scaleSurvivors = false } = cullDistance;
  if (!(Number.isFinite(near) && Number.isFinite(far) && near >= 0 && far > near))
    throw new RangeError(`Lod: cullDistance needs 0 <= near < far, both finite, got ${near} and ${far}`);
  const scale = space.getMaxScaleOnAxis();
  target.eye.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverse.copy(space).invert());
  target.near = near / scale;
  target.far = far / scale;
  target.survivors = scaleSurvivors;
  return target;
}

/** A Cull to write into (see `cullIn`). */
export const emptyCull = (): Cull => ({ eye: new Vector3(), near: 0, far: 0, survivors: false });

import * as THREE from "three";
import type { Lod } from "@drawcall/lod";
import { boundingSphere } from "../../../packages/lod/src/bounds.js";
import { subtense } from "../../../packages/lod/src/fade.js";
import { at } from "./must.js";

/** The height `lod` measures itself at (before Lod.quality) for `camera` on a `height` px screen. */
export function pixelsOf(lod: Lod, camera: THREE.Camera, height: number): number {
  const source = lod.levels[0]?.object;
  if (!source) throw new Error("pixelsOf: the Lod has no source");
  const sphere = boundingSphere(source).applyMatrix4(source.matrix);
  const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  lod.updateMatrixWorld();
  return (subtense(lod.matrixWorld, sphere, eye) * at(camera.projectionMatrix.elements, 5) * height) / 2;
}

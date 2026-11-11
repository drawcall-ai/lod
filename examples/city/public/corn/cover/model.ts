import * as THREE from "three/webgpu";
import { plant } from "../model.ts";
import { canopy, plantGroup, side } from "./shapes.ts";
import { BLOCK, layout, VARIANTS } from "../layout.ts";
import type { CornMaterials } from "../tissue.ts";

/** Which cover of a block: the canopy over it (no axis), or the wall along its +x or +z side. */
export type CoverAxis = "" | "x" | "z";

/** The plants of block design `design` a cover is baked from: those near its wall, with an axis. */
export function patch(materials: CornMaterials, design: number, axis: CoverAxis): THREE.Group {
  const variants = Array.from({ length: VARIANTS }, (_, variant) => variant);
  const tasselled = variants.map((variant) => plant(materials, variant));
  const bare = variants.map((variant) => plant(materials, variant, false, false));
  const places = layout(design).filter((p) => !axis || (axis === "x" ? p.x : p.z) > BLOCK / 2 - 1);
  return plantGroup({ tasselled, bare }, places);
}

/** The shell a cover is baked onto: the ridged canopy, or the wall along `axis`. */
export const coverLow = (axis: CoverAxis): THREE.Mesh => new THREE.Mesh(axis ? side(axis) : canopy(1));

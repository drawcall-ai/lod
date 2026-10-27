import type * as THREE from "three/webgpu";
import { detail } from "./detail.ts";
import { low } from "./low.ts";
import type { HouseParams } from "./params.ts";

export { houseInterior } from "./interior.ts";
export { type HouseParams, heights, houseParams } from "./params.ts";

/** A house at full detail and as the closed low shell built from the same params. */
export function house(params: HouseParams): { detail: THREE.Group; low: THREE.Mesh } {
  return { detail: detail(params), low: low(params) };
}

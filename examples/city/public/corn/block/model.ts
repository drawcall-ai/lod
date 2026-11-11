import * as THREE from "three/webgpu";
import { plant } from "../model.ts";
import { canopy, plantGroup, wall } from "./shapes.ts";
import { BLOCK, layout, VARIANTS } from "../layout.ts";
import type { Materials } from "../materials.ts";

/** A wall of a block: the one along its +x or +z side. */
export type Wall = "x" | "z";

/** The plants of block design `design` its canopy is baked from, or with a `wall` those near that wall. */
export function plants(materials: Materials, design: number, wall: Wall | undefined): THREE.Group {
  const variants = Array.from({ length: VARIANTS }, (_, variant) => variant);
  const tasselled = variants.map((variant) => plant(materials, variant));
  const bare = variants.map((variant) => plant(materials, variant, false, false));
  const places = layout(design).filter((p) => !wall || (wall === "x" ? p.x : p.z) > BLOCK / 2 - 1);
  return plantGroup({ tasselled, bare }, places);
}

/** The wall a script's `?wall=` asks for, checked: none for the canopy. */
export function wallOf(query: URLSearchParams): Wall | undefined {
  const wall = query.get("wall");
  if (wall === null || wall === "x" || wall === "z") return wall ?? undefined;
  throw new Error(`corn block: wall must be x or z, not ${wall}`);
}

/** The shell a block's plants are baked onto: the ridged canopy, or the wall `which`. */
export const shell = (which: Wall | undefined): THREE.Mesh => new THREE.Mesh(which ? wall(which) : canopy(1));

import * as THREE from "three/webgpu";
import { once } from "../materials.ts";

/** Plant tissue coloured by vertex colours: stalk, sheaths, tassel, silk, roots. */
export const tissue = once(() => new THREE.MeshStandardMaterial({ name: "corn-tissue", vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }));

/**
 * How finely the round parts (stalk, sheaths, roots, silk, tassel) are tessellated:
 * "fine" for close-ups, "field" for the plants of a field, seen from a metre or more.
 */
export type Detail = "fine" | "field";

/** `segments` along and `radial` around a tube at `detail`. */
export function tubeSegments(detail: Detail, segments: number, radial: number): [number, number] {
  return detail === "fine" ? [segments, radial] : [Math.max(3, Math.round(segments * 0.35)), Math.max(4, Math.round(radial * 0.6))];
}

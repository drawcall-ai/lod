import { vec3 } from "three/tsl";
import type * as THREE from "three/webgpu";

/**
 * The colour of the ground grass stands on, which its blades' neutral shading is multiplied by. Here a meadow's green; a
 * host whose grass takes its ground's colour shares that through GLTSLoader's `modules`, keyed by this helper's URL.
 */
export function groundColor(): THREE.Node<"vec3"> {
  return vec3(0.16, 0.24, 0.07);
}

import { uniform } from "three/tsl";
import * as THREE from "three/webgpu";

/**
 * The distances (m) from the camera over which a block rises out of the soil: sunk nearer than x, whole from y on.
 * Here every block stands whole; a host drawing a field's plants in front of its blocks shares a uniform it moves with
 * them through GLTSLoader's `modules`, keyed by this helper's URL.
 */
export function skirt() {
  return uniform(new THREE.Vector2(-2, -1));
}

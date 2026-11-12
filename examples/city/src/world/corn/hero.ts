import * as THREE from "three/webgpu";
import type { GLTSScene } from "@drawcall/glts";
import { HERO_VARIANT } from "../../../public/corn/layout.ts";
import { scripts } from "../../loading.ts";
import { sourceBox } from "../bounds.ts";
import { lodOf } from "../scatter.ts";
import type { Terrain } from "../terrain.ts";
import { seatMatrix } from "./seat.ts";

/** The plant the tour ends at, with every leaf in detail, at `spot`, and the ladybird on its leaf; where the tour looks at each. */
export async function heroPlant(
  spot: { at: THREE.Vector3; yaw: number },
  terrain: Terrain,
): Promise<{ hero: GLTSScene; ladybird: GLTSScene; anchors: { hero: THREE.Vector3; ladybird: THREE.Vector3 } }> {
  const at = new THREE.Vector3(spot.at.x, terrain.height(spot.at.x, spot.at.z), spot.at.z);
  const [hero, ladybird] = await Promise.all([scripts.loadAsync(`/corn/index.glts?variant=${HERO_VARIANT}&hero=1`), scripts.loadAsync("/ladybird/index.glts")]);
  const centre = sourceBox(lodOf(ladybird).levels).getCenter(new THREE.Vector3());
  hero.name = "hero corn plant";
  hero.position.copy(at);
  hero.rotation.y = spot.yaw;
  ladybird.name = "ladybird";
  hero.updateMatrix();
  hero.matrix.clone().multiply(seatMatrix()).decompose(ladybird.position, ladybird.quaternion, ladybird.scale);
  ladybird.updateMatrixWorld();
  const anchor = centre.applyMatrix4(ladybird.matrixWorld);
  return { hero, ladybird, anchors: { hero: at, ladybird: anchor } };
}

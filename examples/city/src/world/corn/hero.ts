import * as THREE from "three/webgpu";
import { Lod, type LodGpu } from "@drawcall/lod";
import { loader } from "../../loading.ts";
import { sourceBox } from "../bounds.ts";
import type { Terrain } from "../terrain.ts";
import { plantRequest } from "./levels.ts";
import { HERO, LADYBIRD } from "../../../public/content/ladders.ts";

export async function heroPlant(
  spot: { at: THREE.Vector3; yaw: number },
  terrain: Terrain,
  gpu: LodGpu,
): Promise<{ hero: Lod; ladybird: Lod; anchors: { hero: THREE.Vector3; ladybird: THREE.Vector3 } }> {
  const at = new THREE.Vector3(spot.at.x, terrain.height(spot.at.x, spot.at.z), spot.at.z);
  const [plantLevels, ladybirdLevels] = await Promise.all([loader.loadAsync(plantRequest(HERO)), loader.loadAsync(LADYBIRD)]);
  // measured before its Lod takes the source level in
  const centre = sourceBox(ladybirdLevels).getCenter(new THREE.Vector3());
  const hero = new Lod(plantLevels, gpu);
  hero.name = "hero corn plant";
  hero.position.copy(at);
  hero.rotation.y = spot.yaw;
  const ladybird = new Lod(ladybirdLevels, gpu);
  ladybird.name = "ladybird";
  ladybird.position.copy(at);
  ladybird.rotation.y = spot.yaw;
  ladybird.updateMatrixWorld();
  const anchor = centre.applyMatrix4(ladybird.matrixWorld);
  return { hero, ladybird, anchors: { hero: at, ladybird: anchor } };
}

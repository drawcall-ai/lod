import * as THREE from "three/webgpu";
import { Lod } from "@drawcall/lod";
import { loader } from "../../loading.ts";
import { sourceBox } from "../bounds.ts";
import type { Terrain } from "../terrain.ts";
import { plantRequest } from "./levels.ts";

export async function heroPlant(
  spot: { at: THREE.Vector3; yaw: number; variant: number },
  terrain: Terrain,
): Promise<{ hero: Lod; ladybird: Lod; anchors: { hero: THREE.Vector3; ladybird: THREE.Vector3 } }> {
  const at = new THREE.Vector3(spot.at.x, terrain.height(spot.at.x, spot.at.z), spot.at.z);
  const [plantLevels, ladybirdLevels] = await Promise.all([
    loader.loadAsync(plantRequest(`/corn/plant.glts?variant=${spot.variant}&hero=1`)),
    loader.loadAsync({
      url: `/corn/ladybird.glts?variant=${spot.variant}`,
      levels: [
        { type: "impostor", maxPixels: 20, resolution: 64 },
        { type: "empty", maxPixels: 2 },
      ],
    }),
  ]);
  const hero = new Lod(plantLevels);
  hero.name = "hero corn plant";
  hero.position.copy(at);
  hero.rotation.y = spot.yaw;
  const ladybird = new Lod(ladybirdLevels);
  ladybird.name = "ladybird";
  ladybird.position.copy(at);
  ladybird.rotation.y = spot.yaw;
  ladybird.updateMatrixWorld();
  const anchor = sourceBox(ladybirdLevels).getCenter(new THREE.Vector3()).applyMatrix4(ladybird.matrixWorld);
  return { hero, ladybird, anchors: { hero: at, ladybird: anchor } };
}

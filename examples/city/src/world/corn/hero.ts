import * as THREE from "three/webgpu";
import { CachedLodLoader, Lod, type LodGpu } from "@drawcall/lod";
import { arriving, manager } from "../../loading.ts";
import { sourceBox } from "../bounds.ts";
import type { Terrain } from "../terrain.ts";
import { loadHero } from "./levels.ts";
import { seatMatrix } from "./seat.ts";

const loadLadybird = () =>
  new CachedLodLoader(manager, arriving()).loadAsync({
    url: "/ladybird/index.glts",
    levels: [
      { type: "impostor", maxPixels: 20, resolution: 64 },
      { type: "empty", maxPixels: 2 },
    ],
  });

export async function heroPlant(
  spot: { at: THREE.Vector3; yaw: number },
  terrain: Terrain,
  gpu: LodGpu,
): Promise<{ hero: Lod; ladybird: Lod; anchors: { hero: THREE.Vector3; ladybird: THREE.Vector3 } }> {
  const at = new THREE.Vector3(spot.at.x, terrain.height(spot.at.x, spot.at.z), spot.at.z);
  const [plantLevels, ladybirdLevels] = await Promise.all([loadHero(), loadLadybird()]);
  // measured before its Lod takes the source level in
  const centre = sourceBox(ladybirdLevels).getCenter(new THREE.Vector3());
  const hero = new Lod(plantLevels, gpu);
  hero.name = "hero corn plant";
  hero.position.copy(at);
  hero.rotation.y = spot.yaw;
  const ladybird = new Lod(ladybirdLevels, gpu);
  ladybird.name = "ladybird";
  hero.updateMatrix();
  hero.matrix.clone().multiply(seatMatrix()).decompose(ladybird.position, ladybird.quaternion, ladybird.scale);
  ladybird.updateMatrixWorld();
  const anchor = centre.applyMatrix4(ladybird.matrixWorld);
  return { hero, ladybird, anchors: { hero: at, ladybird: anchor } };
}

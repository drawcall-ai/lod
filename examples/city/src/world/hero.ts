import * as THREE from "three/webgpu";
import { ImpostorMesh, Lod } from "@drawcall/lod";
import { cornPlant, leafMaterial } from "../content/corn/index.ts";
import { ladybird } from "../content/ladybird.ts";
import { culled, thresholds } from "./levels.ts";
import type { Terrain } from "./terrain.ts";

const UP = new THREE.Vector3(0, 1, 0);

/**
 * The hero plant, a `Lod` of its own: finely tessellated leaves up close, then the same
 * impostor as its variant in the field. The ladybird sits on its flattest leaf near
 * mid-height, a `Lod` of the beetle and nothing (it is gone below two pixels).
 */
export function heroPlant(
  spot: { at: THREE.Vector3; yaw: number; seed: number },
  far: { object: ImpostorMesh; maxPixels?: number },
  terrain: Terrain,
): { hero: Lod; ladybird: Lod } {
  const detail = cornPlant(spot.seed, { leafSegments: [192, 24] });
  // before the Lod replaces the materials with its faded copies
  const seat = leafSeat(detail);
  const lod = thresholds(new Lod([detail, new ImpostorMesh(far.object.impostor, 1, { parallax: 0 }), new THREE.Group()]), [far, culled(1)]);
  lod.name = "hero corn plant";
  lod.position.set(spot.at.x, terrain.height(spot.at.x, spot.at.z), spot.at.z);
  lod.rotation.y = spot.yaw;
  lod.updateMatrixWorld(true);

  const beetle = ladybird();
  const holder = new THREE.Group();
  holder.position.copy(seat.point);
  holder.quaternion.setFromUnitVectors(UP, seat.normal);
  holder.add(beetle);
  beetle.rotation.y = seat.heading;
  holder.applyMatrix4(lod.matrixWorld);
  const bug = thresholds(new Lod([holder, new THREE.Group()]), [culled(2)]);
  bug.name = "ladybird";
  return { hero: lod, ladybird: bug };
}

/**
 * Where on `plant` (in its own space) the ladybird sits: the leaf vertex that faces most
 * squarely up, between 1 and 1.6 m high, near the midrib and a third of the way out.
 */
function leafSeat(plant: THREE.Object3D): { point: THREE.Vector3; normal: THREE.Vector3; heading: number } {
  const leaves = plant.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh && c.material === leafMaterial());
  if (!leaves) throw new Error("corn plant has no leaf mesh");
  const position = leaves.geometry.getAttribute("position");
  const normal = leaves.geometry.getAttribute("normal");
  const uv = leaves.geometry.getAttribute("uv");
  let best = -1;
  let score = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    const across = Math.abs(uv.getX(i) - 0.5);
    const along = uv.getY(i);
    if (y < 1 || y > 1.6 || across > 0.2 || across < 0.08 || along < 0.25 || along > 0.45) continue;
    const s = normal.getY(i);
    if (s > score) {
      score = s;
      best = i;
    }
  }
  if (best < 0) throw new Error("no leaf of the hero plant can seat the ladybird");
  const point = new THREE.Vector3().fromBufferAttribute(position, best);
  const up = new THREE.Vector3().fromBufferAttribute(normal, best).normalize();
  // face along the blade: toward the next vertex outward
  const ahead = new THREE.Vector3().fromBufferAttribute(position, Math.min(best + 25, position.count - 1)).sub(point);
  return { point, normal: up, heading: Math.atan2(ahead.x, ahead.z) };
}

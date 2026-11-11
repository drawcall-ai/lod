import * as THREE from "three/webgpu";
import { HERO_LEAF } from "../../../public/corn/model.ts";

/**
 * Where the ladybird sits on the hero plant, in the plant's space: what leafSeat finds on it. Building the hero plant
 * takes seconds, so the page keeps the result; test/world/corn/seat.test.ts holds it to leafSeat.
 */
export const LADYBIRD_SEAT = {
  point: new THREE.Vector3(0.234367, 1.49719, -0.058676),
  normal: new THREE.Vector3(-0.595192, 0.802471, 0.042267),
  heading: 1.926841,
};

/** The ladybird's transform in its plant's space: the beetle, built on y = 0 facing +z, stood on LADYBIRD_SEAT. */
export function seatMatrix(): THREE.Matrix4 {
  const { point, normal, heading } = LADYBIRD_SEAT;
  const tilt = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal.clone().normalize());
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
  return new THREE.Matrix4().compose(point, tilt.multiply(turn), new THREE.Vector3(1, 1, 1));
}

/**
 * Where on `plant` (in its own space) the ladybird sits: the leaf vertex that faces most
 * squarely up, between 1 and 1.6 m high, near the midrib and a third of the way out.
 * `plant` is the hero plant: each blade a `HERO_LEAF` grid, stored row by row along it.
 */
export function leafSeat(plant: THREE.Object3D): { point: THREE.Vector3; normal: THREE.Vector3; heading: number } {
  const leaves = plant.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh && !Array.isArray(c.material) && c.material.name === "corn-leaf");
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
  // face along the blade: toward the same vertex of the next row outward
  const row = HERO_LEAF[1] + 1;
  const ahead = new THREE.Vector3().fromBufferAttribute(position, Math.min(best + row, position.count - 1)).sub(point);
  return { point, normal: up, heading: Math.atan2(ahead.x, ahead.z) };
}

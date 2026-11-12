import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three/webgpu";
import { HERO_LEAF, plant } from "../../../public/corn/model.ts";
import { materials } from "../../../public/corn/materials.ts";
import { HERO_VARIANT } from "../../../public/corn/layout.ts";
import { LADYBIRD_SEAT } from "../../../src/world/corn/seat.ts";

test("LADYBIRD_SEAT is where the ladybird sits the ladybird on the hero plant", () => {
  const seat = leafSeat(plant(materials(), HERO_VARIANT, true));
  assert.ok(seat.point.distanceTo(LADYBIRD_SEAT.point) < 1e-6, `point ${seat.point.toArray()}`);
  assert.ok(seat.normal.distanceTo(LADYBIRD_SEAT.normal) < 1e-6, `normal ${seat.normal.toArray()}`);
  assert.ok(Math.abs(seat.heading - LADYBIRD_SEAT.heading) < 1e-6, `heading ${seat.heading}`);
});

/**
 * Where on `plant` (in its own space) the ladybird sits: the leaf vertex that faces most
 * squarely up, between 1 and 1.6 m high, near the midrib and a third of the way out.
 * `plant` is the hero plant: each blade a `HERO_LEAF` grid, stored row by row along it.
 */
function leafSeat(plant: THREE.Object3D): { point: THREE.Vector3; normal: THREE.Vector3; heading: number } {
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

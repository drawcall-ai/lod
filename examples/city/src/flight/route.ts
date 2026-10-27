import * as THREE from "three/webgpu";
import type { Corn } from "../world/corn/index.ts";
import type { Plan } from "../world/plan.ts";
import type { Key } from "./tour.ts";

/**
 * The tour's poses: the whole world from two kilometres up, down over the town roofs,
 * along a street at head height, over the forest's edge, down into the meadow's grass,
 * into the corn, to one plant, onto a leaf, and the ladybird on it filling the screen.
 * Headings keep the sun mostly behind the camera's shoulder.
 */
export function route(plan: Plan, corn: Corn): Key[] {
  const ground = (x: number, z: number, above: number) => new THREE.Vector3(x, plan.terrain.height(x, z) + above, z);
  const plaza = ground(plan.plaza.x, plan.plaza.z, 2);
  const street = coreStreet(plan);
  const along = Math.atan2(street.dir.y, street.dir.x);
  const end = new THREE.Vector2(street.at.x + street.dir.x * 45, street.at.y + street.dir.y * 45);
  // a house near the street's end, looked at square from in front, from where its baked level shows
  const facade = [...plan.houses].sort((a, b) => Math.hypot(a.spot.x - end.x, a.spot.z - end.y) - Math.hypot(b.spot.x - end.x, b.spot.z - end.y))[0]?.spot;
  if (!facade) throw new Error("the town has no houses");
  const hero = corn.hero.position.clone();
  const bug = corn.ladybird.levels[0]?.object.getWorldPosition(new THREE.Vector3());
  if (!bug) throw new Error("the ladybird has no source level");
  const k = (name: string, time: number, target: THREE.Vector3, distance: number, heading: number, pitchDegrees: number): Key => ({
    name,
    time,
    target,
    distance,
    heading,
    pitch: THREE.MathUtils.degToRad(pitchDegrees),
  });
  return [
    k("world", 0, ground(-350, -250, 0), 2900, 2.5, 50),
    k("town", 9, plaza.clone().add(new THREE.Vector3(60, 0, 40)), 650, 2.3, 38),
    k("roofs", 17, plaza, 110, 2.1, 28),
    k("street", 25, ground(street.at.x, street.at.y, 1.6), 14, along + Math.PI, 8),
    k("street end", 32, ground(end.x, end.y, 1.6), 18, along + Math.PI - 0.3, 10),
    k("facade", 37, new THREE.Vector3(facade.x, facade.y + 3, facade.z), 30, Math.atan2(Math.cos(facade.angle), Math.sin(facade.angle)) + 0.2, 22),
    k("forest", 45, ground(-300, -120, 8), 260, 2.2, 26),
    k("forest edge", 52, ground(-150, -50, 5), 30, 1.9, 10),
    k("meadow", 57, ground(-128, -30, 0.25), 3, 2.2, 12),
    k("cornfield", 63, ground(-60, 10, 1.5), 55, 2.3, 24),
    k("rows", 69, hero.clone().add(new THREE.Vector3(0, 1.4, 0)), 9, 2.5, 22),
    k("plant", 75, hero.clone().add(new THREE.Vector3(0, 1.3, 0)), 1.8, 2.6, 18),
    k("leaf", 82, bug.clone(), 0.22, 2.7, 35),
    k("ladybird", 90, bug.clone().add(new THREE.Vector3(0, 0.0015, 0)), 0.016, 2.8, 30),
  ];
}

/** A street with pavements near the plaza: a point on it and its direction (x/z). */
function coreStreet(plan: Plan): { at: THREE.Vector2; dir: THREE.Vector2 } {
  const centre = new THREE.Vector2(plan.plaza.x, plan.plaza.z);
  const street = plan.roads
    .filter((r) => r.pavement)
    .map((r) => {
      const [a, b] = r.points;
      if (!a || !b) throw new Error("a street without ends");
      return { a, b, mid: a.clone().add(b).multiplyScalar(0.5) };
    })
    .sort((x, y) => x.mid.distanceTo(centre) - y.mid.distanceTo(centre))
    .find((s) => s.mid.distanceTo(centre) > 60);
  if (!street) throw new Error("the town has no street with pavements");
  const dir = street.b.clone().sub(street.a).normalize();
  return { at: street.a.clone().addScaledVector(dir, 12), dir };
}

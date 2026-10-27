import * as THREE from "three/webgpu";
import { axes, type Field, type Road } from "./plan.ts";

/**
 * Roads outside town: the main road continuing the town's axis west to the edge and east
 * past the fields, a second road north–south, and a farm track along one side of every
 * field, joined to the nearest road.
 */
export function country(town: { x: number; z: number }, through: THREE.Vector2[], fields: Field[]): Road[] {
  const first = through[0];
  const last = through[through.length - 1];
  if (!first || !last) throw new Error("the town has no main axis");
  const v = (x: number, z: number) => new THREE.Vector2(x, z);
  const main: Road = {
    points: [
      ...smooth([v(-2350, -760), v(-1700, -700), first], 20),
      ...through.slice(1, -1),
      ...smooth([last, v(-560, -430), v(-200, -330), v(120, -210), v(620, -170), v(1300, 80), v(2350, 260)], 20),
    ],
    width: 7,
    kind: "main",
    pavement: false,
  };
  const cross: Road = {
    points: smooth(crossRoad(town), 20),
    width: 6.5,
    kind: "main",
    pavement: false,
  };
  const roads = [main, cross];
  for (const field of fields) {
    // along the field's west edge, from the nearest point of a road
    const { x: ax, z: az } = axes(field.angle);
    const corner = (sx: number, sz: number) =>
      v(field.x, field.z)
        .addScaledVector(ax, sx * (field.halfX + 6))
        .addScaledVector(az, sz * (field.halfZ + 6));
    const a = corner(-1, -1);
    const b = corner(-1, 1);
    const start = nearest(roads, a);
    roads.push({ points: smooth([start, start.clone().lerp(a, 0.5), a, b], 12), width: 3.5, kind: "track", pavement: false });
  }
  for (const road of roads) for (const p of road.points) if (Math.abs(p.x) > 2390 || Math.abs(p.y) > 2390) p.clampScalar(-2390, 2390);
  return roads;
}

/** The north–south road's course: from the south edge past the town's east side to the north edge. */
export function crossRoad(town: { x: number; z: number }): THREE.Vector2[] {
  const v = (x: number, z: number) => new THREE.Vector2(x, z);
  return [v(-560, -2350), v(-640, -1400), v(town.x + 300, town.z + 120), v(-480, 200), v(-150, 1100), v(-60, 2350)];
}

/** A centripetal Catmull-Rom curve through `points`, sampled every `step` metres. */
export function smooth(points: THREE.Vector2[], step: number): THREE.Vector2[] {
  const curve = new THREE.CatmullRomCurve3(
    points.map((p) => new THREE.Vector3(p.x, 0, p.y)),
    false,
    "centripetal",
  );
  const count = Math.max(2, Math.ceil(curve.getLength() / step));
  return curve.getSpacedPoints(count).map((p) => new THREE.Vector2(p.x, p.z));
}

function nearest(roads: Road[], to: THREE.Vector2): THREE.Vector2 {
  let best: THREE.Vector2 | undefined;
  for (const road of roads) for (const p of road.points) if (!best || p.distanceTo(to) < best.distanceTo(to)) best = p;
  if (!best) throw new Error("no road to join");
  return best.clone();
}

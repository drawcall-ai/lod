import { Box3, Ray, Vector3, type Matrix4, type Object3D } from "three/webgpu";
import { forEachVertex } from "../../bounds.js";
import { isLight } from "../../three.js";

/** Most rooms an interior may have: six faces each in texture arrays of at most 256 layers. */
const MAX_ROOMS = 42;

/** Share of the smaller box two rooms may overlap by: walls that meet, not rooms inside rooms. */
const OVERLAP = 0.02;

/**
 * The boxes of `interior`'s rooms, in the source's own space: one per direct child, the
 * bounds of what it draws. `placement` puts the interior in the source's space.
 *
 * Lights are refused: wherever the source draws they would be scene lights, so every
 * switch to or from it changes the scene's light count (and recompiles every lit
 * material), and an InstancedLod's templates light nothing. Lamps glow with emissive
 * materials instead.
 */
export function readBoxes(interior: Object3D, placement: Matrix4): Box3[] {
  interior.traverse((node) => {
    if (isLight(node)) throw new Error(`bakeMesh: the interior has a light ("${node.name}"); give lamps emissive materials instead`);
  });
  const rooms = interior.children;
  if (rooms.length === 0) throw new Error("bakeMesh: the interior has no rooms: each direct child of it is one room");
  if (rooms.length > MAX_ROOMS) throw new Error(`bakeMesh: the interior has ${rooms.length} rooms, at most ${MAX_ROOMS} are supported`);
  const boxes = rooms.map((room, i) => {
    if (room.matrixAutoUpdate) room.updateMatrix();
    const matrix = placement.clone().multiply(room.matrix);
    const box = new Box3();
    forEachVertex(room, (p) => box.expandByPoint(p.applyMatrix4(matrix)));
    if (box.isEmpty()) throw new Error(`bakeMesh: room ${i} ("${room.name}") of the interior draws nothing`);
    return box;
  });
  boxes.forEach((a, i) =>
    boxes.slice(i + 1).forEach((b, k) => {
      const shared = volume(a.clone().intersect(b));
      if (shared > OVERLAP * Math.min(volume(a), volume(b)))
        throw new Error(
          `bakeMesh: rooms ${i} ("${rooms[i]?.name}") and ${i + k + 1} ("${rooms[i + k + 1]?.name}") of the interior overlap: each room fills a box of its own`,
        );
    }),
  );
  return boxes;
}

function volume(box: Box3): number {
  if (box.isEmpty()) return 0;
  const { x, y, z } = box.getSize(new Vector3());
  return x * y * z;
}

/**
 * How far behind glass a room may begin: half the thinnest room's smallest side. A wall
 * between glass and room is thinner than any room; a ray that met no room within half a
 * room's size is not looking into one through this glass.
 */
export function windowDepth(boxes: readonly Box3[]): number {
  const size = new Vector3();
  return Math.min(...boxes.map((box) => Math.min(...box.getSize(size).toArray()))) / 2;
}

const ray = new Ray();
const enter = new Vector3();

/**
 * The room a ray from `origin` along unit `direction` is in or enters first within
 * `far`: the room behind a window. -1 for none.
 */
export function roomAlong(boxes: readonly Box3[], origin: Vector3, direction: Vector3, far: number): number {
  ray.set(origin, direction);
  let nearest = -1;
  let best = far;
  boxes.forEach((box, i) => {
    const distance = box.containsPoint(origin) ? 0 : ray.intersectBox(box, enter)?.distanceTo(origin);
    if (distance === undefined || distance > best) return;
    best = distance;
    nearest = i;
  });
  return nearest;
}

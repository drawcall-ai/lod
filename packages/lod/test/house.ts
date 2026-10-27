import { BackSide, BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, type Material } from "three/webgpu";

// A house with one room behind one window, for the interior tests.

/** A 2 m box with a 1 m window of clear glass in its +z face, blended unless `glass` is given. */
export function house(glass: Material = new MeshStandardMaterial({ color: 0xc8d8e0, roughness: 0.2, transparent: true, opacity: 0.25 })): Group {
  const wall = new MeshStandardMaterial({ color: 0x8a8070, roughness: 0.9 });
  const box = new BoxGeometry(2, 2, 2);
  const index = box.index?.array ?? [];
  // BoxGeometry groups: +x, -x, +y, -y, +z, -z; the +z face gets a hole.
  box.setIndex(box.groups.filter((_, i) => i !== 4).flatMap((g) => Array.from(index.slice(g.start, g.start + g.count)))).clearGroups();
  const group = new Group().add(new Mesh(box, wall));
  for (const [x, y, w, h] of [
    [0, 0.75, 2, 0.5],
    [0, -0.75, 2, 0.5],
    [-0.75, 0, 0.5, 1],
    [0.75, 0, 0.5, 1],
  ] as const)
    group.add(new Mesh(new PlaneGeometry(w, h), wall).translateX(x).translateY(y).translateZ(1));
  group.add(new Mesh(new PlaneGeometry(1, 1), glass).translateZ(0.98));
  return group;
}

/** Walls of a room seen from inside, one colour each: +x, -x, +y, -y, +z, -z. */
const WALLS = [0xd03020, 0x20b040, 0xe0e0e0, 0x806040, 0x101010, 0x2040d0];

/**
 * One room filling the house, its walls in `WALLS`: the far wall (-z) lit by the scene,
 * the others glowing (unlit) in their colours.
 */
export function interior(): Group {
  const walls = WALLS.map((color, i) =>
    i === 5 ? new MeshStandardMaterial({ color, roughness: 1, side: BackSide }) : new MeshBasicMaterial({ color, side: BackSide }),
  );
  return new Group().add(new Mesh(new BoxGeometry(1.8, 1.8, 1.8), walls));
}

export const low = () => new Mesh(new BoxGeometry(2, 2, 2));

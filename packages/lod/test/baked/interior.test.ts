// Interior mapping: rooms read from an interior, window texels found in the bake, and
// baked windows that render like the source's real rooms behind real glass.
import {
  AmbientLight,
  BackSide,
  BoxGeometry,
  DataTexture,
  DirectionalLight,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
  Vector3,
  type Object3D,
} from "three/webgpu";
import { describe, expect, it } from "vitest";
import { bakeMesh } from "../../src/baked/index.js";
import { readBoxes } from "../../src/baked/interior/rooms.js";
import { InstancedLod } from "../../src/instanced/index.js";
import { Lod } from "../../src/lod.js";
import { house, interior, low } from "../house.js";
import { InteriorMaterial } from "../../src/baked/interior/material.js";
import { isStandardNode } from "../../src/three.js";
import { GPU_TIMEOUT, render as draw } from "../gpu.js";

const SIZE = 96;

/**
 * `object` seen from `eye` looking at `at`, as RGBA pixels, in ambient light of
 * `ambient`, and with a sun shining from `sun` if given (which would light the source's
 * room through its walls: no shadows here).
 */
function render(object: Object3D, eye: Vector3, at = new Vector3(0, 0, 1), ambient = 0.6, sun?: Vector3): Promise<Uint8Array> {
  const scene = new Scene().add(object, new AmbientLight(0xffffff, ambient));
  if (sun) scene.add(new DirectionalLight(0xffffff, 3).translateX(sun.x).translateY(sun.y).translateZ(sun.z));
  const camera = new PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.copy(eye);
  camera.lookAt(at);
  return draw(scene, camera, SIZE).finally(() => scene.remove(object));
}

/** Mean colour of the pixels within `radius` of the image centre, where the window is. */
function windowColor(pixels: Uint8Array, radius = 4): [number, number, number] {
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = SIZE / 2 - radius; y < SIZE / 2 + radius; y++)
    for (let x = SIZE / 2 - radius; x < SIZE / 2 + radius; x++) {
      for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (pixels[(y * SIZE + x) * 4 + c] ?? 0);
      count++;
    }
  return [0, 1, 2].map((c) => (sum[c] ?? 0) / count) as [number, number, number];
}

const distance = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - (b[i] ?? 0))));

/** The windows texture of a baked mesh: per texel, room + 1 and the glass's coverage. */
function windows(mesh: Mesh): Uint8Array {
  const { material } = mesh;
  if (!(material instanceof InteriorMaterial) || !material.rooms) throw new Error("expected a baked material with rooms");
  const { data } = material.rooms.windows.image;
  if (!(data instanceof Uint8Array)) throw new Error("expected 8-bit windows");
  return data;
}

/** The baked base colour pixels of `mesh`. */
function colors(mesh: Mesh): Uint8Array {
  const { material } = mesh;
  if (Array.isArray(material) || !isStandardNode(material) || !(material.map instanceof DataTexture)) throw new Error("expected a baked material");
  const { data } = material.map.image;
  if (!(data instanceof Uint8Array)) throw new Error("expected 8-bit pixels");
  return data;
}

describe("interiors", { timeout: GPU_TIMEOUT }, () => {
  it("reads one room per child of the interior, and refuses rooms that overlap", () => {
    const rooms = new Group().add(new Mesh(new BoxGeometry(1, 2, 1)).translateX(-0.5), new Mesh(new BoxGeometry(1, 2, 1)).translateX(0.5));
    const boxes = readBoxes(rooms, new Matrix4().makeTranslation(0, 1, 0));
    expect(boxes.map(({ min, max }) => [...min.toArray(), ...max.toArray()])).toEqual([
      [-1, 0, -0.5, 0, 2, 0.5],
      [0, 0, -0.5, 1, 2, 0.5],
    ]);
    const crowded = new Group().add(new Mesh(new BoxGeometry(1, 2, 1)), new Mesh(new BoxGeometry(1, 2, 1)).translateX(0.5));
    expect(() => readBoxes(crowded, new Matrix4())).toThrow(/overlap/);
    expect(() => readBoxes(new Group(), new Matrix4())).toThrow(/no rooms/);
  });

  it("bakes the exterior alone and flags the glass texels as windows into the room behind", async () => {
    const plain = await bakeMesh(house(), { low: low(), textureSize: 64 });
    const source = house();
    const rooms = interior();
    source.add(rooms);
    const baked = await bakeMesh(source, { low: low(), textureSize: 64, interior: rooms });
    expect(rooms.visible).toBe(true);
    expect(colors(baked)).toEqual(colors(plain));
    const data = windows(baked);
    const shares = data.filter((_, i) => i % 2 === 1 && data[i] !== 0);
    // The window is 1/24 of the box's surface: about that share of the covered texels.
    expect(shares.length).toBeGreaterThan(20);
    // Glass of opacity 0.25 shows 0.75 of the room.
    expect(new Set(shares)).toEqual(new Set([191]));
    // Every texel names the room, so filtering across the window's edge finds it.
    expect(new Set(data.filter((_, i) => i % 2 === 0))).toEqual(new Set([1]));
  });

  it("shows the room through the window, its far wall head-on and a side wall from aside", async () => {
    const rooms = interior();
    const source = house().add(rooms);
    const baked = await bakeMesh(source, { low: low(), textureSize: 128, interior: rooms });
    const front = new Vector3(0, 0, 5);
    const aside = new Vector3(3.5, 0, 3.6);
    // Head-on, the far wall: lit by the light reaching the window, at any intensity.
    for (const ambient of [0.6, 2.5]) {
      const [real, fake] = [await render(source, front, undefined, ambient), await render(baked, front, undefined, ambient)];
      expect(distance(windowColor(real), windowColor(fake))).toBeLessThan(6);
    }
    const fake = await render(baked, front);
    const [realAside, fakeAside] = [await render(source, aside), await render(baked, aside)];
    expect(distance(windowColor(realAside), windowColor(fakeAside))).toBeLessThan(6);
    // Parallax: from aside the window shows another wall.
    expect(distance(windowColor(fake), windowColor(fakeAside))).toBeGreaterThan(40);
  });

  it("looks into the rooms of a moved source from a rotated Lod and a rotated InstancedLod copy", async () => {
    const rooms = interior();
    const source = house().add(rooms);
    source.position.set(0.3, 0, 0);
    const baked = await bakeMesh(source, { low: low(), textureSize: 128, interior: rooms });
    const turn = new Matrix4().makeRotationY(0.4);
    const lod = new Lod([source.clone(), baked.clone()]);
    lod.quaternion.setFromRotationMatrix(turn);
    const instanced = new InstancedLod([source.clone(), baked.clone()], 1);
    instanced.forceLevel = 1;
    instanced.setMatrixAt(0, turn);
    const window = new Vector3(0.3, 0, 1).applyMatrix4(turn);
    for (const offset of [new Vector3(0, 0, 4), new Vector3(2.5, 0.5, 3)]) {
      const eye = window.clone().add(offset);
      lod.forceLevel = 0;
      const real = windowColor(await render(lod, eye, window));
      lod.forceLevel = 1;
      const fake = windowColor(await render(lod, eye, window));
      expect(distance(real, fake)).toBeLessThan(12);
      expect(distance(fake, windowColor(await render(instanced, eye, window)))).toBeLessThan(2);
    }
  });

  it("shows the next room through a doorway in the room behind the window", async () => {
    const grey = new MeshBasicMaterial({ color: 0x808080, side: BackSide });
    // Room A behind the window, its back wall (z = 0) a frame around a 0.6 m doorway.
    const shell = new BoxGeometry(1.8, 1.8, 0.9);
    const index = shell.index?.array ?? [];
    shell.setIndex(shell.groups.filter((_, i) => i !== 5).flatMap((g) => Array.from(index.slice(g.start, g.start + g.count)))).clearGroups();
    const front = new Group().add(new Mesh(shell, grey).translateZ(0.45));
    const frame = new MeshBasicMaterial({ color: 0x808080 });
    for (const [x, y, w, h] of [
      [0, 0.6, 1.8, 0.6],
      [0, -0.6, 1.8, 0.6],
      [-0.6, 0, 0.6, 0.6],
      [0.6, 0, 0.6, 0.6],
    ] as const)
      front.add(new Mesh(new PlaneGeometry(w, h), frame).translateX(x).translateY(y));
    // Room B behind it, blue.
    const back = new Mesh(new BoxGeometry(1.8, 1.8, 0.9), new MeshBasicMaterial({ color: 0x2040d0, side: BackSide })).translateZ(-0.45);
    const rooms = new Group().add(front, back);
    const source = house().add(rooms);
    const baked = await bakeMesh(source, { low: low(), textureSize: 128, interior: rooms });
    const eye = new Vector3(0, 0, 5);
    const [real, fake] = [windowColor(await render(source, eye)), windowColor(await render(baked, eye))];
    expect(fake[2]).toBeGreaterThan(fake[0] + 60);
    expect(distance(real, fake)).toBeLessThan(6);
  });

  it("keeps the reflection of fully transmissive glass over the room", async () => {
    const rooms = interior();
    const source = house(new MeshPhysicalMaterial({ roughness: 0.3, transmission: 1 })).add(rooms);
    const baked = await bakeMesh(source, { low: low(), textureSize: 64, interior: rooms });
    const eye = new Vector3(0, 0, 5);
    // A sun behind the eye: its highlight sits on the glass, the room is not lit by it.
    const dull = windowColor(await render(baked, eye, undefined, 0.6));
    const sunny = windowColor(await render(baked, eye, undefined, 0.6, eye));
    expect(Math.min(...sunny.map((v, i) => v - (dull[i] ?? 0)))).toBeGreaterThan(10);
  });

  it("refuses lights in the interior, and fails when no glass looks into a room", async () => {
    const lit = interior().add(new PointLight());
    await expect(bakeMesh(house().add(lit), { low: low(), textureSize: 32, interior: lit })).rejects.toThrow(/light/);
    const rooms = new Group().add(new Mesh(new BoxGeometry(0.5, 0.5, 0.5), new MeshBasicMaterial()).translateX(5));
    await expect(bakeMesh(house(), { low: low(), textureSize: 32, interior: rooms })).rejects.toThrow(/no glass/);
  });
});

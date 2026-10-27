import {
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector3,
  type BufferAttribute,
} from "three/webgpu";
import { afterEach, describe, expect, it } from "vitest";
import { drawOf } from "../src/fade.js";
import { InstancedLod } from "../src/instanced/index.js";
import { Lod } from "../src/lod.js";
import { isMesh } from "../src/three.js";
import { GPU_TIMEOUT, render, renderer } from "./gpu.js";

const box = (name: string) => Object.assign(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()), { name });
const DIAMETER = 2 * Math.sqrt(3);
const tan = Math.tan(Math.PI / 6);
/** The target the tests render into: the height levels are measured on. */
const SIZE = 64;
/** Distance at which the box is `pixels` tall on the target. */
const at = (pixels: number) => (DIAMETER * SIZE) / (2 * tan * pixels);

/** Camera at the origin looking down -z; instance i at the distance where it is `heights[i]` px tall. */
function setup(heights: number[]) {
  const lod = new InstancedLod([box("source"), box("simplified"), box("impostor")], heights.length);
  lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 40, 10][i] ?? level.maxPixels));
  heights.forEach((pixels, i) => lod.setMatrixAt(i, new Matrix4().makeTranslation(0, 0, -at(pixels))));
  const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
  return { lod, camera };
}

/** Render `lod` from `camera`, so the GPU selects its instances: twice, the first frame tells it the target's height. */
async function select(lod: InstancedLod, camera: PerspectiveCamera): Promise<void> {
  const scene = new Scene().add(lod.parent ?? lod);
  await render(scene, camera, SIZE);
  await render(scene, camera, SIZE);
}

const read = async (attribute: BufferAttribute) => renderer.getArrayBufferAsync(attribute);
const meshes = (lod: InstancedLod) => lod.children.filter(isMesh);

/** Per level mesh, what the GPU put in its slots: each instance's distance, colour and signed fade, in slot order. */
async function slots(lod: InstancedLod) {
  return Promise.all(
    meshes(lod).map(async (mesh) => {
      const args = mesh.geometry.getIndirect();
      const draw = drawOf(mesh);
      if (!args || draw?.kind !== "instances" || !draw.fades || !(mesh instanceof InstancedMesh)) throw new Error("not a level mesh");
      const offset = mesh.geometry.indirectOffset;
      if (typeof offset !== "number") throw new Error("one draw per mesh");
      const words = new Uint32Array(await read(args));
      const count = words[offset / 4 + 1] ?? 0;
      // The level's first slot: the draw's first instance (after its base vertex, indexed).
      const first = words[offset / 4 + (mesh.geometry.index ? 4 : 3)] ?? 0;
      const matrices = new Float32Array(await read(mesh.instanceMatrix));
      const fades = new Float32Array(await read(draw.fades));
      const colors = mesh.instanceColor && new Float32Array(await read(mesh.instanceColor));
      return Array.from({ length: count }, (_, k) => {
        const j = first + k;
        return {
          distance: Math.round(-(matrices[j * 16 + 14] ?? 0)),
          fade: fades[j] ?? 0,
          color: colors ? new Color().fromArray(colors, j * 4).getHex() : null,
        };
      });
    }),
  );
}

/** Per level, the distances of the instances it draws, nearest first. */
const distances = async (lod: InstancedLod) => (await slots(lod)).map((level) => level.map((slot) => slot.distance).sort((a, b) => a - b));

afterEach(() => {
  Lod.quality = 1;
});

describe("InstancedLod", { timeout: GPU_TIMEOUT }, () => {
  it("puts every instance into its level, and into both neighbours inside a fade, splitting its pixels", async () => {
    const heights = [100, 40 * (1 - Lod.fade / 2), 25, 10 * (1 - Lod.fade / 2), 5];
    const { lod, camera } = setup(heights);
    await select(lod, camera);
    const d = heights.map((h) => Math.round(at(h)));
    expect(await distances(lod)).toEqual([
      [d[0], d[1]],
      [d[1], d[2], d[3]],
      [d[3], d[4]],
    ]);
    // Half way through the fade: the finer side keeps the dither below 0.5, the coarser the rest.
    const [source, simplified] = await slots(lod);
    expect(source?.find((slot) => slot.distance === d[1])?.fade).toBeCloseTo(-0.5, 2);
    expect(simplified?.find((slot) => slot.distance === d[1])?.fade).toBeCloseTo(0.5, 2);
    expect(simplified?.find((slot) => slot.distance === d[2])?.fade).toBe(0);
  });

  it("reports each instance's finest drawn level, and carries colours with the instances", async () => {
    const { lod, camera } = setup([100, 40 * (1 - Lod.fade / 2), 5]);
    expect(lod.levelOf(0)).toBe(null);
    lod.setColorAt(2, new Color(1, 0, 0));
    await select(lod, camera);
    expect([0, 1, 2].map((i) => lod.levelOf(i))).toEqual([0, 0, 2]);
    const byValue = (a: number | null, b: number | null) => (a ?? 0) - (b ?? 0);
    const colours = (await slots(lod)).map((level) => level.map((slot) => slot.color).sort(byValue));
    expect(colours).toEqual([[0xffffff, 0xffffff], [0xffffff], [0xff0000]]);
    // A colour set later follows its instance into the level it moves to.
    lod.setColorAt(1, new Color(0, 0, 1));
    lod.forceLevel = 2;
    await select(lod, camera);
    expect((await slots(lod))[2]?.map((slot) => slot.color).sort(byValue)).toEqual([0x0000ff, 0xff0000, 0xffffff]);
  });

  it("measures an empty level 0 by the first level that draws, and draws nothing of it", async () => {
    const lod = new InstancedLod([new Group(), box("baked")], 2);
    lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 40][i] ?? level.maxPixels));
    lod.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -at(100)));
    lod.setMatrixAt(1, new Matrix4().makeTranslation(0, 0, -at(20)));
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    await select(lod, camera);
    expect([lod.levelOf(0), lod.levelOf(1)]).toEqual([0, 1]);
    expect(await distances(lod)).toEqual([[Math.round(at(20))]]);
    expect(() => new InstancedLod([new Group()], 1)).toThrow(/no level has visible geometry/);
  });

  it("scales heights by Lod.quality, draws only forceLevel, and nothing of an instance at scale 0", async () => {
    const { lod, camera } = setup([14, 100]);
    Lod.quality = 0.5;
    await select(lod, camera);
    expect((await distances(lod)).map((list) => list.length)).toEqual([1, 0, 1]);
    lod.forceLevel = 1;
    lod.setMatrixAt(1, new Matrix4().makeScale(0, 0, 0));
    await select(lod, camera);
    expect((await distances(lod)).map((list) => list.length)).toEqual([0, 1, 0]);
    expect(lod.levelOf(1)).toBe(null);
  });

  it("selects again for a camera or a parent that moved", async () => {
    const { lod, camera } = setup([100]);
    const parent = new Group().add(lod);
    await select(lod, camera);
    expect((await distances(lod)).map((list) => list.length)).toEqual([1, 0, 0]);
    parent.position.z = -at(5) + at(100);
    await select(lod, camera);
    expect((await distances(lod)).map((list) => list.length)).toEqual([0, 0, 1]);
    camera.position.z = -at(5) + at(100);
    await select(lod, camera);
    expect((await distances(lod)).map((list) => list.length)).toEqual([1, 0, 0]);
  });

  it("draws no level no instance can be in, by the heights its bounds allow", async () => {
    const { lod, camera } = setup([5, 4]);
    await select(lod, camera);
    expect(meshes(lod).map((mesh) => mesh.visible)).toEqual([false, false, true]);
    lod.setMatrixAt(1, new Matrix4().makeTranslation(0, 0, -at(100)));
    await select(lod, camera);
    expect(meshes(lod).map((mesh) => mesh.visible)).toEqual([true, true, true]);
    expect(await distances(lod)).toEqual([[Math.round(at(100))], [], [Math.round(at(5))]]);
  });

  it("uploads every instance moved since the last frame, levelOf read in between", async () => {
    const { lod, camera } = setup([100, 100]);
    await select(lod, camera);
    lod.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -at(5)));
    lod.levelOf(0);
    lod.setMatrixAt(1, new Matrix4().makeTranslation(0, 0, -at(25)));
    await select(lod, camera);
    expect(await distances(lod)).toEqual([[], [Math.round(at(25))], [Math.round(at(5))]]);
  });

  it("is culled by the bounds of every instance, a fine level only near the camera", async () => {
    const { lod, camera } = setup([100, 5]);
    await select(lod, camera);
    // The source draws nothing smaller than the next level's fade: never the far instance.
    const [source, , impostor] = meshes(lod).map(
      (mesh) => (z: number) => (mesh instanceof InstancedMesh && mesh.boundingSphere?.containsPoint(new Vector3(0, 0, z))) ?? false,
    );
    expect([source?.(-at(100)), source?.(-at(5))]).toEqual([true, false]);
    expect([impostor?.(-at(100)), impostor?.(-at(5))]).toEqual([true, true]);
    const contains = (z: number) => lod.bounds.containsPoint(new Vector3(0, 0, z));
    expect([contains(-at(100)), contains(-at(5))]).toEqual([true, true]);
    lod.setMatrixAt(1, new Matrix4().makeTranslation(0, 0, -at(60)));
    await select(lod, camera);
    expect([contains(-at(100)), contains(-at(5))]).toEqual([true, false]);
    expect(() => lod.setMatrixAt(2, new Matrix4())).toThrow(/index 2/);
  });

  it.each([true, false])("keeps the draw range and material groups (indexed: %s)", (indexed) => {
    for (const grouped of [false, true]) {
      const box = new BoxGeometry(2, 2, 2);
      const geometry = indexed ? box : box.toNonIndexed();
      geometry.clearGroups();
      geometry.addGroup(0, 18, 0);
      geometry.addGroup(18, 18, 1);
      geometry.addGroup(36, 6, 0);
      geometry.setDrawRange(6, 24);
      const red = new MeshBasicMaterial({ color: 0xff0000 });
      const green = new MeshBasicMaterial({ color: 0x00ff00 });
      const lod = new InstancedLod([new Mesh(geometry, grouped ? [red, green] : red)], 1);
      const draws = meshes(lod).map((mesh) => {
        const args = mesh.geometry.getIndirect();
        const offset = mesh.geometry.indirectOffset;
        if (!args || typeof offset !== "number") throw new Error("not an indirect draw");
        return [args.array[offset / 4], args.array[offset / 4 + 2]];
      });
      expect(draws).toEqual(
        grouped
          ? [
              [12, 6],
              [12, 18],
              [0, 36],
            ]
          : [[24, 6]],
      );
      expect(meshes(lod).map((mesh) => mesh.geometry.index !== null)).toEqual(draws.map(() => indexed));
      lod.dispose();
      if (!grouped) green.dispose();
      if (!indexed) box.dispose();
    }
  });

  it("refuses sources it cannot instance", () => {
    expect(() => new InstancedLod([new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial(), 2)], 3)).toThrow(/InstancedMesh/);
    expect(() => new InstancedLod([new Lod([box("a")])], 3)).toThrow(/Lod/);
  });

  it("clones its instances and levels, and disposes what it built", async () => {
    const { lod, camera } = setup([100, 5]);
    lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 30, 9][i] ?? level.maxPixels));
    const clone = lod.clone();
    expect(clone.count).toBe(2);
    expect(clone.levels.map((level) => level.maxPixels)).toEqual([Infinity, 30, 9]);
    expect(clone.getMatrixAt(1, new Matrix4()).equals(lod.getMatrixAt(1, new Matrix4()))).toBe(true);
    await select(clone, camera);
    expect((await distances(clone)).map((list) => list.length)).toEqual([1, 0, 1]);
    let disposed = 0;
    for (const { object } of clone.levels) object.traverse((node) => isMesh(node) && [node.material].flat()[0]?.addEventListener("dispose", () => disposed++));
    clone.dispose();
    expect(disposed).toBe(3);
    expect(() => new InstancedLod([], 3).copy(lod)).toThrow(/same count/);
  });

  it("raycasts every instance's source, on the raycaster's layers only", () => {
    const { lod } = setup([100, 5]);
    lod.updateMatrixWorld();
    const hits = new Raycaster(new Vector3(0.3, 0.2, 0), new Vector3(0, 0, -1)).intersectObject(lod);
    expect(hits.map((hit) => [hit.object, hit.instanceId])).toEqual([
      [lod, 0],
      [lod, 1],
    ]);
    lod.levels[0]?.object.layers.set(1);
    expect(new Raycaster(new Vector3(0.3, 0.2, 0), new Vector3(0, 0, -1)).intersectObject(lod)).toEqual([]);
  });
});

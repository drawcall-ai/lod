import { BoxGeometry, Color, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Vector3, type Object3D } from "three";
import { afterEach, describe, expect, it } from "vitest";
import { InstancedLod } from "../src/instanced/index.js";
import { Lod } from "../src/lod.js";
import { isInstancedMesh } from "../src/three.js";

const box = (name: string) => Object.assign(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()), { name });
const DIAMETER = 2 * Math.sqrt(3);
const tan = Math.tan(Math.PI / 6);
/** Distance at which the box is `pixels` tall on a 1080 px screen. */
const at = (pixels: number) => (DIAMETER * 1080) / (2 * tan * pixels);

/** Camera at the origin looking down -z; instance i at the distance where it is `heights[i]` px tall. */
function setup(heights: number[]) {
  const lod = new InstancedLod([box("source"), box("simplified"), box("impostor")], heights.length);
  lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 400, 100][i] ?? level.maxPixels));
  heights.forEach((pixels, i) => lod.setMatrixAt(i, new Matrix4().makeTranslation(0, 0, -at(pixels))));
  const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
  camera.updateMatrixWorld();
  lod.updateMatrixWorld();
  return { lod, camera };
}

const meshes = (lod: Object3D) => lod.children.filter(isInstancedMesh);
/** Per level mesh: the distances of the instances it draws. */
function drawn(lod: InstancedLod): number[][] {
  const matrix = new Matrix4();
  return meshes(lod).map((mesh) => Array.from({ length: mesh.count }, (_, j) => Math.round(-mesh.getMatrixAt(j, matrix).elements[14])));
}

afterEach(() => {
  Lod.quality = 1;
});

describe("InstancedLod", () => {
  it("sorts every instance into its level, and into both neighbours inside a fade", () => {
    const heights = [1000, 400 * (1 - Lod.fade / 2), 250, 100 * (1 - Lod.fade / 2), 50];
    const { lod, camera } = setup(heights);
    lod.update(camera);
    const d = heights.map((h) => Math.round(at(h)));
    expect(drawn(lod)).toEqual([
      [d[0], d[1]],
      [d[1], d[2], d[3]],
      [d[3], d[4]],
    ]);
    expect(meshes(lod).map((mesh) => mesh.visible)).toEqual([true, true, true]);
    expect(lod.levels.map((level) => level.count)).toEqual([2, 3, 2]);
  });

  it("reports each instance's finest drawn level, and carries colours with the instances", () => {
    const { lod, camera } = setup([1000, 400 * (1 - Lod.fade / 2), 50]);
    expect(lod.levelOf(0)).toBe(null);
    lod.setColorAt(2, new Color(1, 0, 0));
    lod.update(camera);
    expect([0, 1, 2].map((i) => lod.levelOf(i))).toEqual([0, 0, 2]);
    const colors = meshes(lod).map((mesh) => Array.from({ length: mesh.count }, (_, j) => mesh.getColorAt(j, new Color()).getHex()));
    expect(colors).toEqual([[0xffffff, 0xffffff], [0xffffff], [0xff0000]]);
    // A colour set later follows its instance into the slot it moves to.
    lod.setColorAt(1, new Color(0, 0, 1));
    lod.forceLevel = 2;
    lod.update(camera);
    expect(meshes(lod)[2]?.instanceColor?.array.slice(0, 9)).toEqual(new Float32Array([1, 0, 0, 1, 1, 1, 0, 0, 1]));
  });

  it("measures an empty level 0 by the first level that draws", () => {
    const lod = new InstancedLod([new Group(), box("baked")], 1);
    lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 400][i] ?? level.maxPixels));
    lod.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -at(1000)));
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    camera.updateMatrixWorld();
    lod.updateMatrixWorld();
    lod.update(camera);
    expect(lod.levelOf(0)).toBe(0);
    expect(() => new InstancedLod([new Group()], 1)).toThrow(/no level has visible geometry/);
  });

  it("scales heights by Lod.quality and draws only forceLevel", () => {
    const { lod, camera } = setup([140, 1000]);
    Lod.quality = 0.5;
    lod.update(camera);
    expect(drawn(lod).map((list) => list.length)).toEqual([1, 0, 1]);
    lod.forceLevel = 1;
    lod.update(camera);
    expect(drawn(lod).map((list) => list.length)).toEqual([0, 2, 0]);
    expect(meshes(lod).map((mesh) => mesh.visible)).toEqual([false, true, false]);
  });

  it("sorts again only when the camera, a matrix or a setting changed", () => {
    const { lod, camera } = setup([1000, 50]);
    lod.update(camera);
    const [source] = meshes(lod);
    if (!source) throw new Error("no source mesh");
    const version = source.instanceMatrix.version;
    lod.update(camera);
    expect(source.instanceMatrix.version).toBe(version);
    lod.setMatrixAt(1, new Matrix4().makeTranslation(0, 0, -at(1000)));
    lod.update(camera);
    expect(source.instanceMatrix.version).toBeGreaterThan(version);
    expect(drawn(lod).map((list) => list.length)).toEqual([2, 0, 0]);
    expect(() => lod.setMatrixAt(2, new Matrix4())).toThrow(/index 2/);
  });

  it("culls each level by the instances it draws", () => {
    const { lod, camera } = setup([1000, 50]);
    lod.update(camera);
    const [source, , impostor] = meshes(lod);
    const contains = (mesh: Object3D | undefined, z: number) =>
      (mesh && isInstancedMesh(mesh) && mesh.boundingSphere?.containsPoint(new Vector3(0, 0, z))) ?? false;
    expect([contains(source, -at(1000)), contains(source, -at(50)), contains(impostor, -at(50))]).toEqual([true, false, true]);
    lod.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -at(60)));
    lod.update(camera);
    expect([contains(source, -at(1000)), contains(impostor, -at(60))]).toEqual([false, true]);
  });

  it("refuses sources it cannot instance", () => {
    expect(() => new InstancedLod([new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial(), 2)], 3)).toThrow(/InstancedMesh/);
    expect(() => new InstancedLod([new Lod([box("a")])], 3)).toThrow(/Lod/);
  });

  it("writes only instances that change level", () => {
    const { lod, camera } = setup([1000, 250, 50]);
    lod.update(camera);
    const versions = () => meshes(lod).map((mesh) => mesh.instanceMatrix.version);
    const before = versions();
    // A small move re-sorts, but no instance changes level: nothing is written.
    camera.position.x = 0.01;
    camera.updateMatrixWorld();
    lod.update(camera);
    expect(versions()).toEqual(before);
    // Three times as far from the first instance (1000 px): it drops to level 1.
    camera.position.z = 3 * at(1000);
    camera.updateMatrixWorld();
    lod.update(camera);
    expect(drawn(lod).map((list) => list.length)).toEqual([0, 2, 1]);
  });

  it("sorts again when a parent moves", () => {
    const { lod, camera } = setup([1000]);
    const parent = new Group().add(lod);
    lod.update(camera);
    expect(drawn(lod).map((list) => list.length)).toEqual([1, 0, 0]);
    parent.position.z = -at(50) + at(1000);
    parent.updateMatrixWorld();
    lod.update(camera);
    expect(drawn(lod).map((list) => list.length)).toEqual([0, 0, 1]);
  });

  it("clones its instances and levels, and disposes what it built", () => {
    const { lod, camera } = setup([1000, 50]);
    lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 300, 90][i] ?? level.maxPixels));
    const clone = lod.clone();
    expect(clone.count).toBe(2);
    expect(clone.levels.map((level) => level.maxPixels)).toEqual([Infinity, 300, 90]);
    expect(clone.getMatrixAt(1, new Matrix4()).equals(lod.getMatrixAt(1, new Matrix4()))).toBe(true);
    clone.updateMatrixWorld();
    clone.update(camera);
    expect(drawn(clone).map((list) => list.length)).toEqual([1, 0, 1]);
    let disposed = 0;
    for (const mesh of meshes(clone)) [mesh.material].flat()[0]?.addEventListener("dispose", () => disposed++);
    clone.dispose();
    expect(disposed).toBe(3);
    expect(() => new InstancedLod([], 3).copy(lod)).toThrow(/same count/);
  });

  it("raycasts every instance's source, on the raycaster's layers only", () => {
    const { lod } = setup([1000, 50]);
    const hits = new Raycaster(new Vector3(0.3, 0.2, 0), new Vector3(0, 0, -1)).intersectObject(lod);
    expect(hits.map((hit) => [hit.object, hit.instanceId])).toEqual([
      [lod, 0],
      [lod, 1],
    ]);
    lod.levels[0]?.object.layers.set(1);
    expect(new Raycaster(new Vector3(0.3, 0.2, 0), new Vector3(0, 0, -1)).intersectObject(lod)).toEqual([]);
  });
});

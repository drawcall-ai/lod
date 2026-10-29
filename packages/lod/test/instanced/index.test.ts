import {
  AmbientLight,
  Box3,
  BoxGeometry,
  DirectionalLight,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PlaneGeometry,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Sphere,
  Vector3,
  type BufferAttribute,
  type Intersection,
} from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drawOf } from "../../src/fade.js";
import { InstancedLod } from "../../src/instanced/index.js";
import { ImpostorMesh } from "../../src/impostor/mesh/index.js";
import { Lod } from "../../src/lod.js";
import { Wind } from "../../src/wind/index.js";
import { isMesh } from "../../src/three.js";
import { setViewportHeight } from "../../src/view.js";
import { GPU_TIMEOUT, render, renderer, nextLevel } from "../gpu.js";

const box = (name: string) => Object.assign(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()), { name });
const DIAMETER = 2 * Math.sqrt(3);
const tan = Math.tan(Math.PI / 6);
/** The target the tests render into: the height levels are measured on. */
const SIZE = 64;
/** Distance at which the box is `pixels` tall on the target. */
const at = (pixels: number) => (DIAMETER * SIZE) / (2 * tan * pixels);

/** Camera at the origin looking down -z; instance i at the distance where it is `heights[i]` px tall. */
function setup(heights: number[]) {
  const lod = new InstancedLod([{ object: box("source") }, { object: box("simplified") }, { object: box("impostor") }], heights.length);
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
  vi.restoreAllMocks();
});

describe("InstancedLod", { timeout: GPU_TIMEOUT }, () => {
  it("can keep every tier culled before the first draw and recover after an explicit resize", () => {
    const source = box("source");
    const lod = new InstancedLod([{ object: source }, { object: new Group() }], 1);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    const empty = lod.levels[1];
    if (!empty) throw new Error("Missing empty level");
    empty.maxPixels = 10;
    lod.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -at(5)));
    camera.updateMatrixWorld();
    lod.updateMatrixWorld();
    try {
      setViewportHeight(camera, SIZE);
      lod.update(camera);
      expect(meshes(lod).map((mesh) => mesh.visible)).toEqual([false]);
      setViewportHeight(camera, SIZE * 4);
      lod.update(camera);
      expect(meshes(lod).map((mesh) => mesh.visible)).toEqual([true]);
    } finally {
      lod.dispose();
    }
  });

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
    const lod = new InstancedLod([{ object: new Group() }, { object: box("baked") }], 2);
    lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 40][i] ?? level.maxPixels));
    lod.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -at(100)));
    lod.setMatrixAt(1, new Matrix4().makeTranslation(0, 0, -at(20)));
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    await select(lod, camera);
    expect([lod.levelOf(0), lod.levelOf(1)]).toEqual([0, 1]);
    expect(await distances(lod)).toEqual([[Math.round(at(20))]]);
    expect(() => new InstancedLod([{ object: new Group() }], 1)).toThrow(/no level has visible geometry/);
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

  it("uploads every instance moved since the last frame, levelOf read in between", async () => {
    const { lod, camera } = setup([100, 100]);
    await select(lod, camera);
    lod.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -at(5)));
    lod.levelOf(0);
    lod.setMatrixAt(1, new Matrix4().makeTranslation(0, 0, -at(25)));
    await select(lod, camera);
    expect(await distances(lod)).toEqual([[], [Math.round(at(25))], [Math.round(at(5))]]);
  });
});

const mesh = () => new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());

it("replaces a deferred source's coarse fallback after preparation", { timeout: GPU_TIMEOUT }, async () => {
  const deferred = { load: async () => mesh(), maxPixels: Infinity, box: new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)) };
  const crowd = new InstancedLod([deferred, { object: mesh() }], 3);
  crowd.forceLevel = 0;
  for (let i = 0; i < crowd.count; i++) crowd.setMatrixAt(i, new Matrix4().makeTranslation(0, 0, -5));
  const scene = new Scene().add(crowd);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  try {
    await render(scene, camera);
    expect(crowd.levelOf(0)).toBe(1);
    await nextLevel(crowd, camera);
    crowd.update(camera);
    expect(crowd.children).toHaveLength(2);
    expect(crowd.levelOf(0)).toBe(0);
  } finally {
    crowd.dispose();
  }
});

it("keeps shared instance slots alive when an arriving impostor fails compilation", { timeout: GPU_TIMEOUT }, async () => {
  const impostor = new ImpostorMesh({
    version: 3,
    layout: "full",
    frames: 4,
    size: 16,
    box: [-1, 0, -1, 1, 2, 1],
    halfSize: 1.5,
    maps: ["base", "normalDepth", "orm"],
    layers: [0, 1, 2].map(() => [16, 8, 4].map((size) => new Uint8Array(size * size * 4))),
  });
  const deferred = { load: async () => impostor, maxPixels: Infinity, box: new Box3().setFromArray(impostor.impostor.box) };
  const crowd = new InstancedLod([deferred, { object: mesh() }], 1);
  crowd.forceLevel = 0;
  crowd.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -5));
  crowd.setColorAt(0, new Color("red"));
  const scene = new Scene().add(crowd);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const failure = new Error("test compile failure");
  let matricesDisposed = 0;
  let colorsDisposed = 0;
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await render(scene, camera);
    const compile = renderer.compileAsync.bind(renderer);
    vi.spyOn(renderer, "compileAsync").mockImplementation(async (...args) => {
      const [object] = args;
      if (!(object instanceof ImpostorMesh)) return compile(...args);
      if (!object.instanceColor) throw new Error("Missing prepared impostor slots");
      object.instanceMatrix.addEventListener("dispose", () => matricesDisposed++);
      object.instanceColor.addEventListener("dispose", () => colorsDisposed++);
      throw failure;
    });
    await expect(nextLevel(crowd, camera)).rejects.toBe(failure);
    expect(report).toHaveBeenCalledWith(failure);
    expect(matricesDisposed).toBe(0);
    expect(colorsDisposed).toBe(0);
    expect(crowd.levelOf(0)).toBe(1);
    expect(crowd.children).toHaveLength(1);
    expect((await render(scene, camera)).some((byte) => byte > 0)).toBe(true);
  } finally {
    crowd.dispose();
  }
});

it("installs shared decoded detail only in crowds whose current view demands it", { timeout: GPU_TIMEOUT }, async () => {
  const load = vi.fn(async () => mesh());
  const deferred = { load, maxPixels: Infinity, box: new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)) };
  const levels = [deferred, { object: mesh() }];
  const near = new InstancedLod(levels, 1);
  const away = new InstancedLod(levels, 1);
  near.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -5));
  away.setMatrixAt(0, new Matrix4().makeTranslation(500, 0, -5));
  near.forceLevel = away.forceLevel = 0;
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const scene = new Scene().add(near, away);
  try {
    const nearInstalled = nextLevel(near, camera);
    await render(scene, camera);
    await nearInstalled;
    expect(near.children).toHaveLength(2);
    expect(away.children).toHaveLength(1);
    expect(away.pending).toBe(false);

    camera.position.x = 500;
    const awayInstalled = nextLevel(away, camera);
    await render(scene, camera);
    await awayInstalled;
    expect(away.children).toHaveLength(2);
    expect(load).toHaveBeenCalledOnce();
  } finally {
    near.dispose();
    away.dispose();
  }
});

it("still selects an offscreen crowd when its shadow reaches the visible ground", { timeout: GPU_TIMEOUT }, async () => {
  const source = mesh();
  source.castShadow = true;
  const crowd = new InstancedLod([{ object: source }], 1);
  crowd.position.set(4, 4, 0);
  const ground = new Mesh(new PlaneGeometry(24, 24).rotateX(-Math.PI / 2), new MeshStandardMaterial());
  ground.receiveShadow = true;
  const sun = new DirectionalLight(0xffffff, 3);
  sun.position.set(12, 12, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(256, 256);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 0.1, far: 50 });
  sun.shadow.camera.updateProjectionMatrix();
  const scene = new Scene().add(crowd, ground, sun, sun.target, new AmbientLight(0xffffff, 0.2));
  const camera = new OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
  camera.position.set(0, 20, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  renderer.shadowMap.enabled = true;
  try {
    const shadow = await render(scene, camera);
    scene.remove(crowd);
    sun.shadow.needsUpdate = true;
    const lit = await render(scene, camera.clone());
    const center = (32 * 64 + 32) * 4;
    expect(shadow[center]).toBeLessThan((lit[center] ?? 0) * 0.8);
  } finally {
    renderer.shadowMap.enabled = false;
    crowd.dispose();
    ground.geometry.dispose();
    ground.material.dispose();
    sun.dispose();
  }
});

const shear = new Matrix4().set(1, 0.9, 0.9, 0, 0.9, 1, 0.9, 0, 0.9, 0.9, 1, 0, 0, 0, 0, 1);

function camera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.z = 100;
  camera.updateMatrixWorld();
  return camera;
}

function contains(lod: InstancedLod, matrix: Matrix4, sway = 0): void {
  const point = new Vector3();
  for (const mesh of lod.children) {
    if (!(mesh instanceof InstancedMesh) || !mesh.boundingSphere) throw new Error("Missing level mesh bounds");
    const bounds = mesh.boundingSphere.clone().applyMatrix4(lod.matrixWorld);
    const vertices = mesh.geometry.getAttribute("position");
    for (let i = 0; i < vertices.count; i++) {
      for (const direction of [-1, 1]) {
        point.fromBufferAttribute(vertices, i);
        point.x += direction * point.y * sway;
        point.applyMatrix4(matrix).applyMatrix4(lod.matrixWorld);
        expect(bounds.containsPoint(point)).toBe(true);
      }
    }
  }
}

it("bounds all placed levels and template shear without changing source-based LOD decisions", () => {
  const material = new MeshBasicMaterial();
  const source = new Mesh(new BoxGeometry(2, 2, 2), material);
  source.matrixAutoUpdate = false;
  source.matrix.copy(shear);
  source.updateMatrixWorld(true);
  const coarse = new Mesh(new BoxGeometry(20, 10, 2), material);
  coarse.position.set(30, 10, 0);
  coarse.geometry.computeTangents();
  const lod = new InstancedLod([{ object: source }, { object: coarse }], 1);
  const translated = lod.children[1];
  if (!(translated instanceof InstancedMesh)) throw new Error("Missing translated level mesh");
  expect(new Vector3().fromBufferAttribute(translated.geometry.getAttribute("position"), 0).toArray()).toEqual([40, 15, 1]);
  expect(new Vector3().fromBufferAttribute(coarse.geometry.getAttribute("position"), 0).toArray()).toEqual([10, 5, 1]);
  for (const name of ["normal", "tangent"]) expect(translated.geometry.getAttribute(name).array).toEqual(coarse.geometry.getAttribute(name).array);
  const second = lod.levels[1];
  if (!second) throw new Error("Missing coarse level");
  second.maxPixels = 70;
  const view = camera();
  lod.update(view);
  // The source's max-axis LOD sphere gives ~52px. Using the full geometry
  // envelope for selection would incorrectly select level zero here.
  expect(lod.levelOf(0)).toBe(1);
  contains(lod, new Matrix4());

  lod.setMatrixAt(0, shear);
  lod.matrixAutoUpdate = false;
  lod.matrix.copy(shear);
  lod.updateMatrixWorld(true);
  lod.update(view);
  contains(lod, shear);
  lod.dispose();
});

it("bounds wind on taller coarse levels and cloned crowds", () => {
  const material = new MeshBasicMaterial();
  const source = new Mesh(new BoxGeometry(2, 0, 2), material);
  const coarse = new Mesh(new BoxGeometry(2, 100, 2), material);
  coarse.position.y = 50;
  const lod = new InstancedLod([{ object: source }, { object: coarse }], 1);
  const wind = new Wind();
  wind.apply(lod, { amplitude: 1, baseY: 0, height: 1 });
  lod.setMatrixAt(0, shear);
  lod.matrixAutoUpdate = false;
  lod.matrix.copy(shear);
  lod.updateMatrixWorld(true);
  lod.update(camera());
  // Source is flat at the wind base, but the coarse top can move 100 units.
  contains(lod, shear, 1);
  const clone = lod.clone();
  clone.updateMatrixWorld(true);
  clone.update(camera());
  contains(clone, shear, 1);
  clone.dispose();
  lod.dispose();
});

it("raycasts source faces outside the max-axis sphere of a sheared template", () => {
  const source = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
  source.matrixAutoUpdate = false;
  source.matrix.copy(shear);
  source.updateMatrixWorld(true);
  // Three's delegated Mesh.raycast also uses max-axis sphere scaling. A consumer
  // can supply a conservative sphere; our outer broadphase must not reject it first.
  source.geometry.boundingSphere = new Sphere(new Vector3(), 4);
  const lod = new InstancedLod([{ object: source }], 1);
  const face = new Vector3(0.8, 0.9, 1).applyMatrix4(shear);
  const ray = new Raycaster(face.clone().add(new Vector3(0, 0, 10)), new Vector3(0, 0, -1));
  const hits: Intersection[] = [];
  lod.raycast(ray, hits);
  expect(hits).toHaveLength(1);
  expect(hits[0]?.instanceId).toBe(0);
  expect(hits[0]?.point.distanceTo(face)).toBeLessThan(1e-6);
  lod.dispose();
});

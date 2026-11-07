import {
  AmbientLight,
  Box3,
  BoxGeometry,
  DirectionalLight,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Sphere,
  Vector3,
  type BufferAttribute,
  type Camera,
  type Intersection,
} from "three/webgpu";
import { uniform } from "three/tsl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drawOf } from "../../src/fade.js";
import { ARGS_BYTES } from "../../src/instanced/args.js";
import { Instances } from "../../src/instanced/meshes.js";
import { InstancedLod } from "../../src/instanced/index.js";
import { keptFraction } from "../../src/instanced/range.js";
import { Lod } from "../../src/lod.js";
import { HANDOVER_MS } from "../../src/residency.js";
import { Wind } from "../../src/wind/index.js";
import { isMesh } from "../../src/three.js";
import { setViewportHeight } from "../../src/view.js";
import { GPU_TIMEOUT, render, renderer, nextLevel } from "../gpu.js";
import { oneChunk } from "../crowd.js";
import { must } from "../must.js";

const box = (name: string) => Object.assign(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()), { name });
const DIAMETER = 2 * Math.sqrt(3);
const tan = Math.tan(Math.PI / 6);
/** The target the tests render into: the height levels are measured on. */
const SIZE = 64;
/** Distance at which the box is `pixels` tall on the target. */
const at = (pixels: number) => (DIAMETER * SIZE) / (2 * tan * pixels);

/** Camera at the origin looking down -z; instance i at the distance where it is `heights[i]` px tall. */
function setup(heights: number[]) {
  const lod = new InstancedLod([{ object: box("source") }, { object: box("simplified") }, { object: box("impostor") }]);
  lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 40, 10][i] ?? level.maxPixels));
  lod.addChunk({ matrices: heights.flatMap((pixels) => new Matrix4().makeTranslation(0, 0, -at(pixels)).elements) });
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

/** Per level mesh, what the GPU put in its slots for `camera`: each instance's distance, colour and signed fade, in slot order. */
async function slots(lod: InstancedLod, camera: Camera) {
  return Promise.all(
    meshes(lod).map(async (mesh, index) => {
      const draw = drawOf(mesh);
      if (draw?.kind !== "instances" || !draw.slots || !(mesh instanceof Instances)) throw new Error("not a level mesh");
      const { indices, fades, args } = draw.slots(camera);
      // One draw per mesh, in the order of the meshes.
      const offset = args.offset + index * ARGS_BYTES;
      const words = new Uint32Array(await read(args.attribute));
      const count = words[offset / 4 + 1] ?? 0;
      // The level's first slot: the draw's first instance (after its base vertex, indexed).
      const first = words[offset / 4 + (mesh.geometry.index ? 4 : 3)] ?? 0;
      const instances = new Uint32Array(await read(indices));
      const matrices = new Float32Array(await read(mesh.instanceMatrix));
      const signed = new Float32Array(await read(fades));
      const colors = mesh.instanceColor && new Float32Array(await read(mesh.instanceColor));
      return Array.from({ length: count }, (_, k) => {
        const i = instances[first + k] ?? 0;
        return {
          distance: Math.round(-(matrices[i * 16 + 14] ?? 0)),
          fade: signed[first + k] ?? 0,
          color: colors ? new Color().fromArray(colors, i * 4).getHex() : null,
        };
      });
    }),
  );
}

/** Per level, the distances of the instances it draws for `camera`, nearest first. */
const distances = async (lod: InstancedLod, camera: Camera) => (await slots(lod, camera)).map((level) => level.map((slot) => slot.distance).sort((a, b) => a - b));

afterEach(() => {
  Lod.quality = 1;
  vi.restoreAllMocks();
});

describe("InstancedLod", { timeout: GPU_TIMEOUT }, () => {
  it("can keep every tier culled before the first draw and recover after an explicit resize", () => {
    const source = box("source");
    const lod = oneChunk([{ object: source }, { object: new Group() }], 1);
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
    expect(await distances(lod, camera)).toEqual([
      [d[0], d[1]],
      [d[1], d[2], d[3]],
      [d[3], d[4]],
    ]);
    // Half way through the fade: the finer side keeps the dither below 0.5, the coarser the rest.
    const [source, simplified] = await slots(lod, camera);
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
    const colours = (await slots(lod, camera)).map((level) => level.map((slot) => slot.color).sort(byValue));
    expect(colours).toEqual([[0xffffff, 0xffffff], [0xffffff], [0xff0000]]);
    // A colour set later follows its instance into the level it moves to.
    lod.setColorAt(1, new Color(0, 0, 1));
    lod.forceLevel = 2;
    await select(lod, camera);
    expect((await slots(lod, camera))[2]?.map((slot) => slot.color).sort(byValue)).toEqual([0x0000ff, 0xff0000, 0xffffff]);
  });

  it("measures an empty level 0 by the first level that draws, and draws nothing of it", async () => {
    const lod = oneChunk([{ object: new Group() }, { object: box("baked") }], 2);
    lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 40][i] ?? level.maxPixels));
    lod.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -at(100)));
    lod.setMatrixAt(1, new Matrix4().makeTranslation(0, 0, -at(20)));
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    await select(lod, camera);
    expect([lod.levelOf(0), lod.levelOf(1)]).toEqual([0, 1]);
    expect(await distances(lod, camera)).toEqual([[Math.round(at(20))]]);
    expect(() => new InstancedLod([{ object: new Group() }])).toThrow(/no level has visible geometry/);
  });

  it("scales heights by Lod.quality, draws only forceLevel, and nothing of an instance at scale 0", async () => {
    const { lod, camera } = setup([14, 100]);
    Lod.quality = 0.5;
    await select(lod, camera);
    expect((await distances(lod, camera)).map((list) => list.length)).toEqual([1, 0, 1]);
    lod.forceLevel = 1;
    lod.setMatrixAt(1, new Matrix4().makeScale(0, 0, 0));
    await select(lod, camera);
    expect((await distances(lod, camera)).map((list) => list.length)).toEqual([0, 1, 0]);
    expect(lod.levelOf(1)).toBe(null);
  });

  it("selects again for a camera or a parent that moved", async () => {
    const { lod, camera } = setup([100]);
    const parent = new Group().add(lod);
    await select(lod, camera);
    expect((await distances(lod, camera)).map((list) => list.length)).toEqual([1, 0, 0]);
    parent.position.z = -at(5) + at(100);
    await select(lod, camera);
    expect((await distances(lod, camera)).map((list) => list.length)).toEqual([0, 0, 1]);
    camera.position.z = -at(5) + at(100);
    await select(lod, camera);
    expect((await distances(lod, camera)).map((list) => list.length)).toEqual([1, 0, 0]);
  });

  it("draws only the instances in each view, and into a shadow map each at the level its texels resolve", async () => {
    // 50 px tall in view: the source. Behind the camera, it is in the shadow map only; far aside, in neither.
    const { lod, camera } = setup([50, 50, 50]);
    lod.setMatrixAt(1, new Matrix4().makeTranslation(0, 0, at(50)));
    lod.setMatrixAt(2, new Matrix4().makeTranslation(200, 0, -at(50)));
    lod.traverse((node) => (node.castShadow = true));
    const sun = new DirectionalLight();
    sun.position.set(0, 50, -at(50));
    sun.target.position.set(0, 0, -at(50));
    sun.castShadow = true;
    // 64 texels over 32 units: the box, about 3.5 units across, is 7 texels: the coarsest level.
    sun.shadow.mapSize.set(64, 64);
    Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 100 });
    // A receiver, so that the shadow map is drawn.
    const ground = new Mesh(new PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new MeshStandardMaterial());
    ground.position.set(0, -2, -at(50));
    ground.receiveShadow = true;
    const scene = new Scene().add(lod, ground, sun, sun.target);
    const enabled = renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = true;
    try {
      for (let i = 0; i < 2; i++) await render(scene, camera, SIZE);
      expect(await distances(lod, camera)).toEqual([[Math.round(at(50))], [], []]);
      expect((await distances(lod, sun.shadow.camera)).map((list) => list.length)).toEqual([0, 0, 2]);
    } finally {
      renderer.shadowMap.enabled = enabled;
      lod.dispose();
    }
  });

  it("uploads every instance moved since the last frame, levelOf read in between", async () => {
    const { lod, camera } = setup([100, 100]);
    await select(lod, camera);
    lod.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -at(5)));
    lod.levelOf(0);
    lod.setMatrixAt(1, new Matrix4().makeTranslation(0, 0, -at(25)));
    await select(lod, camera);
    expect(await distances(lod, camera)).toEqual([[], [Math.round(at(25))], [Math.round(at(5))]]);
  });
});

const mesh = () => new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());

it("installs shared decoded detail only in crowds near enough to draw it", { timeout: GPU_TIMEOUT }, async () => {
  const load = vi.fn(async () => mesh());
  const deferred = { load, maxPixels: Infinity, box: new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)) };
  const levels = [deferred, { object: mesh(), maxPixels: 5 }];
  const near = oneChunk(levels, 1);
  const away = oneChunk(levels, 1);
  near.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -5));
  away.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -1000));
  const camera = new PerspectiveCamera(60, 1, 0.1, 2000);
  const scene = new Scene().add(near, away);
  try {
    const nearInstalled = nextLevel(near, camera);
    await render(scene, camera);
    await nearInstalled;
    expect(near.children).toHaveLength(2);
    expect(away.children).toHaveLength(1);
    expect(away.pending).toBe(false);

    camera.position.z = -995;
    camera.updateMatrixWorld();
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

it("draws far instances whose coarse level is still loading as nothing, never as the installed source", { timeout: GPU_TIMEOUT }, async () => {
  const bounds = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  const coarse = { load: () => new Promise<Mesh>(() => {}), maxPixels: 5, box: bounds };
  const crowd = oneChunk([{ load: async () => mesh(), maxPixels: Infinity, box: bounds }, coarse], 100);
  for (let i = 0; i < 100; i++) crowd.setMatrixAt(i, new Matrix4().makeTranslation(0, 0, i < 10 ? -5 : -1000));
  const camera = new PerspectiveCamera(60, 1, 0.1, 2000);
  const scene = new Scene().add(crowd);
  try {
    await nextLevel(crowd, camera);
    await render(scene, camera);
    // Only the ten near instances draw the source; the ninety far ones wait for their level, the item held.
    expect((await distances(crowd, camera)).map((level) => level.length)).toEqual([10]);
    expect(crowd.pending).toBe(true);
  } finally {
    crowd.dispose();
  }
});

it("keeps drawing the level each instance showed while the one it walked away to loads, then hands over to it", { timeout: GPU_TIMEOUT }, async () => {
  const bounds = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const coarse = { load: async () => (await gate, mesh()), maxPixels: 5, box: bounds };
  const crowd = oneChunk([{ object: mesh() }, coarse], 4);
  const place = (near: number) => {
    for (let i = 0; i < 4; i++) crowd.setMatrixAt(i, new Matrix4().makeTranslation(0, 0, i < near ? -5 : -1000));
  };
  const camera = new PerspectiveCamera(60, 1, 0.1, 2000);
  const scene = new Scene().add(crowd);
  try {
    place(2);
    await render(scene, camera);
    expect(await distances(crowd, camera)).toEqual([[5, 5]]);
    // The two that showed the source keep it; the two that showed nothing still draw nothing.
    place(0);
    await render(scene, camera);
    expect(await distances(crowd, camera)).toEqual([[1000, 1000]]);
    const arrived = nextLevel(crowd, camera);
    release();
    await arrived;
    await new Promise((resolve) => setTimeout(resolve, HANDOVER_MS));
    await render(scene, camera);
    expect(await distances(crowd, camera)).toEqual([[], [1000, 1000, 1000, 1000]]);
  } finally {
    crowd.dispose();
  }
});

it("gives back the slots of a camera that stopped rendering it", { timeout: GPU_TIMEOUT }, async () => {
  const crowd = oneChunk([{ object: mesh() }], 1);
  crowd.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -5));
  const scene = new Scene().add(crowd);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const once = camera.clone();
  try {
    await render(scene, once);
    const draw = drawOf(must(meshes(crowd)[0]));
    if (draw?.kind !== "instances" || !draw.slots) throw new Error("not a level mesh");
    const freed = vi.fn();
    draw.slots(once).indices.addEventListener("dispose", freed);
    // Two passes of another camera: the one-frame clone no longer views the crowd.
    for (let i = 0; i < 3; i++) await render(scene, camera);
    expect(freed).toHaveBeenCalledOnce();
  } finally {
    crowd.dispose();
  }
});

it("loads the levels its shadow map draws, for casters in view and behind it", { timeout: GPU_TIMEOUT }, async () => {
  const bounds = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  const source = mesh();
  source.castShadow = true;
  const coarse = { load: async () => mesh(), maxPixels: 20, box: bounds };
  const crowd = oneChunk([{ object: source }, coarse], 2);
  // One in view, near enough for its source; one behind the camera, casting into the view.
  crowd.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -5));
  crowd.setMatrixAt(1, new Matrix4().makeTranslation(0, 0, 5));
  crowd.traverse((node) => (node.castShadow = true));
  const sun = new DirectionalLight(0xffffff, 3);
  sun.position.set(0, 20, 0);
  sun.castShadow = true;
  // Too coarse to need the source: about 5 texels a metre.
  sun.shadow.mapSize.set(128, 128);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 0.1, far: 50 });
  sun.shadow.camera.updateProjectionMatrix();
  // Lit ground: a shadow map is drawn only for what receives it.
  const ground = new Mesh(new PlaneGeometry(24, 24).rotateX(-Math.PI / 2), new MeshStandardMaterial());
  ground.position.y = -2;
  ground.receiveShadow = true;
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const scene = new Scene().add(crowd, ground, sun, sun.target);
  renderer.shadowMap.enabled = true;
  try {
    await render(scene, camera);
    await nextLevel(crowd, camera);
    for (let i = 0; i < 3; i++) await render(scene, camera);
    expect(crowd.pending).toBe(false);
    expect(await distances(crowd, camera)).toEqual([[5], []]);
    expect(await distances(crowd, sun.shadow.camera)).toEqual([[], [-5, 5]]);
  } finally {
    renderer.shadowMap.enabled = false;
    crowd.dispose();
    sun.dispose();
    ground.geometry.dispose();
    ground.material.dispose();
  }
});

it("still selects an offscreen crowd when its shadow reaches the visible ground", { timeout: GPU_TIMEOUT }, async () => {
  const source = mesh();
  source.castShadow = true;
  const crowd = oneChunk([{ object: source }], 1);
  crowd.position.set(4, 4, 0);
  // Lit ground under a sun, a world of its own for each render: one shadow map never stands in for another's.
  const made: { dispose(): void }[] = [];
  const world = () => {
    const ground = new Mesh(new PlaneGeometry(24, 24).rotateX(-Math.PI / 2), new MeshStandardMaterial());
    ground.receiveShadow = true;
    const sun = new DirectionalLight(0xffffff, 3);
    sun.position.set(12, 12, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(256, 256);
    Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 0.1, far: 50 });
    sun.shadow.camera.updateProjectionMatrix();
    made.push(ground.geometry, ground.material, sun);
    return new Scene().add(ground, sun, sun.target, new AmbientLight(0xffffff, 0.2));
  };
  const camera = new OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
  camera.position.set(0, 20, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  renderer.shadowMap.enabled = true;
  try {
    const shadow = await render(world().add(crowd), camera);
    const lit = await render(world(), camera.clone());
    const center = (32 * 64 + 32) * 4;
    expect(shadow[center]).toBeLessThan((lit[center] ?? 0) * 0.8);
  } finally {
    renderer.shadowMap.enabled = false;
    crowd.dispose();
    for (const each of made) each.dispose();
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
    if (!(mesh instanceof Instances) || !mesh.boundingSphere) throw new Error("Missing level mesh bounds");
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
  const lod = oneChunk([{ object: source }, { object: coarse }], 1);
  const translated = lod.children[1];
  if (!(translated instanceof Instances)) throw new Error("Missing translated level mesh");
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
  const lod = oneChunk([{ object: source }, { object: coarse }], 1);
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
  const lod = oneChunk([{ object: source }], 1);
  const face = new Vector3(0.8, 0.9, 1).applyMatrix4(shear);
  const ray = new Raycaster(face.clone().add(new Vector3(0, 0, 10)), new Vector3(0, 0, -1));
  const hits: Intersection[] = [];
  lod.raycast(ray, hits);
  expect(hits).toHaveLength(1);
  expect(hits[0]?.instanceId).toBe(0);
  expect(hits[0]?.point.distanceTo(face)).toBeLessThan(1e-6);
  lod.dispose();
});

it("builds identical vertex WGSL for equal material structures across independently created crowds", { timeout: GPU_TIMEOUT }, async () => {
  const first = oneChunk([{ object: mesh() }], 1);
  first.setColorAt(0, new Color("red"));
  const scene = new Scene().add(first);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.z = 5;
  const draw = first.children[0];
  if (!draw) throw new Error("Missing first draw");
  const before = await renderer.debug.getShaderAsync(scene, camera, draw);
  // Unrelated asynchronous asset arrivals allocate nodes between equivalent crowds.
  for (let i = 0; i < 23; i++) uniform(i);
  const second = oneChunk([{ object: mesh() }], 17);
  second.setColorAt(0, new Color("blue"));
  scene.add(second);
  const autoReset = renderer.info.autoReset;
  try {
    const next = second.children[0];
    if (!next) throw new Error("Missing second draw");
    const after = await renderer.debug.getShaderAsync(scene, camera, next);
    expect(before.vertexShader).toContain("lodInstanceMatrices");
    expect(after.vertexShader).toBe(before.vertexShader);
    expect(after.fragmentShader).toBe(before.fragmentShader);
    // Pixel readback can cross a frame, when Three otherwise resets the statistics.
    renderer.info.autoReset = false;
    renderer.info.reset();
    await render(scene, camera);
    // Indirect draws report capacity, a power of two, even though the GPU chooses each level's actual count.
    expect(renderer.info.render.triangles).toBe((1 + 32) * 12);
  } finally {
    renderer.info.autoReset = autoReset;
    first.dispose();
    second.dispose();
  }
});

it("draws colours set after a crowd drew, with the shaders it has", { timeout: GPU_TIMEOUT }, async () => {
  const lod = oneChunk([{ object: mesh() }], 1);
  const scene = new Scene().add(lod);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.z = 5;
  try {
    await render(scene, camera);
    await render(scene, camera);
    lod.setColorAt(0, new Color(1, 0, 0));
    const builds = vi.spyOn(NodeMaterial.prototype, "setup");
    const pixels = await render(scene, camera);
    expect(builds).not.toHaveBeenCalled();
    expect(Array.from(pixels.slice((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4))).toEqual([255, 0, 0, 255]);
  } finally {
    vi.restoreAllMocks();
    lod.dispose();
  }
});

/** A chunk of instances on the -z axis, at distances `distances` from the origin, with keep ratios `keeps`. */
const row = (distances: number[], keeps?: number[]) => ({
  matrices: distances.flatMap((distance) => new Matrix4().makeTranslation(0, 0, -distance).elements),
  keeps,
});

describe("chunks", { timeout: GPU_TIMEOUT }, () => {
  it("adds and removes chunks at stable indices, reusing freed places and growing past them", async () => {
    const lod = new InstancedLod([{ object: box("source") }]);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    try {
      const a = lod.addChunk(row([10, 11]));
      const b = lod.addChunk(row([20]));
      expect([a.start, b.start]).toEqual([0, 2]);
      await select(lod, camera);
      expect(await distances(lod, camera)).toEqual([[10, 11, 20]]);
      lod.removeChunk(a);
      expect(() => lod.removeChunk(a)).toThrow(/not one of its own/);
      expect(() => lod.getMatrixAt(0, new Matrix4())).toThrow(/not an instance of a chunk/);
      // Into the first free place; then, with no run of three left, past the end.
      const c = lod.addChunk({ ...row([30]), colors: [1, 0, 0] });
      const d = lod.addChunk(row([40, 41, 42]));
      expect([c.start, d.start]).toEqual([0, 3]);
      expect(lod.count).toBe(5);
      expect([...lod.chunks]).toEqual([b, c, d]);
      await select(lod, camera);
      expect(await distances(lod, camera)).toEqual([[20, 30, 40, 41, 42]]);
      // A chunk's colours, and white for those of chunks without.
      const colours = (await slots(lod, camera))[0]?.map(({ distance, color }): [number, number | null] => [distance, color]);
      expect(new Map(colours)).toEqual(new Map([[20, 0xffffff], [30, 0xff0000], [40, 0xffffff], [41, 0xffffff], [42, 0xffffff]]));
      expect(lod.levelOf(d.start + 2)).toBe(0);
      expect(lod.getMatrixAt(d.start + 1, new Matrix4()).elements[14]).toBe(-41);
      for (const chunk of [b, c, d]) lod.removeChunk(chunk);
      await select(lod, camera);
      expect(await distances(lod, camera)).toEqual([[]]);
    } finally {
      lod.dispose();
    }
  });

  it("never keeps drawing at a reused place the level its last instance showed, removed and replaced in one frame", async () => {
    // The coarse level never loads: an instance that selects it keeps the level it showed, or draws nothing.
    const bounds = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
    const lod = new InstancedLod([{ object: mesh() }, { load: () => new Promise<Mesh>(() => {}), maxPixels: 5, box: bounds }]);
    const camera = new PerspectiveCamera(60, 1, 0.1, 2000);
    const scene = new Scene().add(lod);
    try {
      // A second chunk keeps the capacity, so the far chunk takes the near one's places.
      const near = lod.addChunk(row([5, 5]));
      lod.addChunk(row([6]));
      await render(scene, camera);
      expect(await distances(lod, camera)).toEqual([[5, 5, 6]]);
      lod.removeChunk(near);
      expect(lod.addChunk(row([1000, 1000])).start).toBe(near.start);
      await render(scene, camera);
      expect(await distances(lod, camera)).toEqual([[6]]);
    } finally {
      lod.dispose();
    }
  });

  it("uploads only an added chunk's instances while it fits, keeping the buffers the draws hold", async () => {
    const lod = new InstancedLod([{ object: box("source") }]);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    try {
      lod.addChunk(row([10, 11, 12]));
      await select(lod, camera);
      const draw = must(meshes(lod)[0]);
      if (!(draw instanceof Instances)) throw new Error("not a level mesh");
      const matrices = draw.instanceMatrix;
      const added = lod.addChunk(row([13]));
      // levelOf measures pending edits, as a selection does.
      lod.levelOf(added.start);
      expect(draw.instanceMatrix).toBe(matrices);
      expect(matrices.updateRanges).toEqual([{ start: 3 * 16, count: 16 }]);
      await select(lod, camera);
      expect(await distances(lod, camera)).toEqual([[10, 11, 12, 13]]);
    } finally {
      lod.dispose();
    }
  });
});

describe("range", { timeout: GPU_TIMEOUT }, () => {
  const keeps = [0.05, 0.9, 0.3, 0.6, 0.1, 0.75, 0.45, 0.2, 0.95, 0.5];
  const spots = keeps.map((_, i) => 10 * (i + 1));
  /** The distances of the instances `range` keeps, measured from `eye` on the z axis. */
  const kept = (eye: number, range: { radius: number; ramp: number }) =>
    spots.filter((distance, i) => (keeps[i] ?? 1) < keptFraction(distance + eye, range));

  it("keeps an instance iff its keep ratio is below the fraction kept at its distance: nested subsets as the camera recedes", async () => {
    const lod = new InstancedLod([{ object: box("source") }]);
    lod.addChunk(row(spots, keeps));
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    const range = { camera, radius: 80, ramp: 60 };
    lod.range = range;
    try {
      let previous: number[] | null = null;
      for (const eye of [0, 15, 30]) {
        camera.position.z = eye;
        camera.updateMatrixWorld();
        await select(lod, camera);
        const [drawn = []] = await distances(lod, camera);
        expect(drawn).toEqual(kept(eye, range));
        expect(drawn.length).toBeGreaterThan(0);
        if (previous) expect(previous).toEqual(expect.arrayContaining(drawn));
        previous = drawn;
      }
      expect(spots.map((_, i) => lod.levelOf(i) !== null)).toEqual(spots.map((spot) => kept(30, range).includes(spot)));
      lod.range = null;
      await select(lod, camera);
      expect((await distances(lod, camera))[0]).toHaveLength(spots.length);
    } finally {
      lod.dispose();
    }
  });

  it("measures distances from the range's camera in shadow maps too, so an instance and its shadow go together", async () => {
    const source = box("source");
    source.castShadow = true;
    const lod = new InstancedLod([{ object: source }]);
    // In view at 10 and 30, behind the view at the same distances, and two beyond the range.
    lod.addChunk({ ...row([10, 30, 50, -10, -30, -50]), keeps: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2] });
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    lod.range = { camera, radius: 50, ramp: 40 };
    // The sun is about 50 from every instance: measured from it, none would draw.
    const sun = new DirectionalLight();
    sun.position.set(0, 50, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(256, 256);
    Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 100 });
    sun.shadow.camera.updateProjectionMatrix();
    const ground = new Mesh(new PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new MeshStandardMaterial());
    ground.position.y = -2;
    ground.receiveShadow = true;
    const scene = new Scene().add(lod, ground, sun, sun.target);
    renderer.shadowMap.enabled = true;
    try {
      for (let i = 0; i < 2; i++) await render(scene, camera, SIZE);
      expect(await distances(lod, camera)).toEqual([[10, 30]]);
      expect(await distances(lod, sun.shadow.camera)).toEqual([[-30, -10, 10, 30]]);
    } finally {
      renderer.shadowMap.enabled = false;
      lod.dispose();
      sun.dispose();
      ground.geometry.dispose();
      ground.material.dispose();
    }
  });

  it("scales survivors by 1 / sqrt of the kept fraction when asked, choosing their level at that size", async () => {
    const lod = new InstancedLod([{ object: box("source") }, { object: box("simplified") }]);
    must(lod.levels[1]).maxPixels = 40;
    // 30 px tall unscaled: the simplified level; where a quarter is kept, twice that: the source.
    const distance = at(30);
    lod.addChunk(row([distance]));
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    lod.range = { camera, radius: distance + 2.5, ramp: 10 };
    try {
      await select(lod, camera);
      expect(lod.levelOf(0)).toBe(1);
      expect((await distances(lod, camera)).map((level) => level.length)).toEqual([0, 1]);
      lod.range = { ...lod.range, scaleSurvivors: true };
      await select(lod, camera);
      expect(lod.levelOf(0)).toBe(0);
      expect((await distances(lod, camera)).map((level) => level.length)).toEqual([1, 0]);
      const draw = must(meshes(lod)[0]);
      if (!(draw instanceof Instances)) throw new Error("not a level mesh");
      const scaled = new Matrix4().fromArray(new Float32Array(await read(draw.instanceMatrix)));
      expect(scaled.getMaxScaleOnAxis()).toBeCloseTo(2, 4);
      expect(scaled.elements[14]).toBeCloseTo(-distance, 3);
    } finally {
      lod.dispose();
    }
  });
});

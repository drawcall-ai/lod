import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  RenderTarget,
  Scene,
  StorageInstancedBufferAttribute,
  type Camera,
  type Object3D,
} from "three/webgpu";
import { describe, expect, it } from "vitest";
import { bakeMesh } from "../src/baked/index.js";
import { disposeTree } from "../src/dispose.js";
import { drawOf } from "../src/fade.js";
import { bakeImpostor } from "../src/impostor/bake/index.js";
import type { Impostor } from "../src/impostor/impostor.js";
import { ImpostorMesh } from "../src/impostor/mesh/index.js";
import { InstancedLod } from "../src/instanced/index.js";
import { Lod } from "../src/lod.js";
import { originalOf } from "../src/material.js";
import { readBytes } from "../src/renderer.js";
import { simplify } from "../src/simplify.js";
import { isMesh } from "../src/three.js";
import { Wind } from "../src/wind/index.js";
import { GPU_TIMEOUT, renderer } from "./gpu.js";

/** Asymmetric, with a child transform: every part must use the same root-space sway. */
function plant(segments = 1): Group {
  const trunk = new Mesh(new BoxGeometry(0.4, 3, 0.4, segments, segments, segments), new MeshStandardMaterial());
  trunk.position.y = 1.5;
  const branch = new Mesh(new BoxGeometry(1.1, 0.5, 0.6, segments, segments, segments), new MeshStandardMaterial());
  branch.position.set(0.55, 2.3, 0.1);
  return new Group().add(trunk, branch);
}

/** `plant()` sheared as a wind of amplitude 0.9 over its 3-unit height at full swing (time 1, speed 0.25) shears it. */
const SHEAR = () => new Matrix4().makeShear(0, 0, 0.3, 0, 0, 0);

let atlas: Promise<Impostor> | undefined;
const baked = () => (atlas ??= bakeImpostor(plant(), { resolution: 128, layout: "full" }));

function view(): PerspectiveCamera {
  const camera = new PerspectiveCamera(22, 1, 0.1, 100);
  camera.position.set(8, 4, 16);
  camera.lookAt(2, 1.4, -1);
  return camera;
}

function placed<T extends Object3D>(object: T): T {
  object.position.set(2, 0, -1);
  object.rotation.y = 0.7;
  object.scale.set(1.3, 0.9, 0.65);
  return object;
}

/** `object` alone from `camera`, 128 px, multisampled: RGBA bytes. */
async function render(object: Object3D, camera: Camera = view(), lit = false): Promise<Uint8Array> {
  const target = new RenderTarget(128, 128, { samples: 4 });
  const scene = new Scene().add(object);
  if (lit) {
    const light = new DirectionalLight(0xffffff, 2);
    light.position.set(4, 5, 3);
    scene.add(light, new AmbientLight(0xffffff, 0.2));
  }
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  const pixels = await readBytes(renderer, target, 0);
  target.dispose();
  scene.remove(object);
  return pixels;
}

/** Shared coverage over either's coverage, by alpha; both must cover something. */
function overlap(a: Uint8Array, b: Uint8Array): number {
  let both = 0;
  let either = 0;
  for (let i = 3; i < a.length; i += 4) {
    const coveredA = (a[i] ?? 0) > 128;
    const coveredB = (b[i] ?? 0) > 128;
    if (coveredA && coveredB) both++;
    if (coveredA || coveredB) either++;
  }
  expect(either).toBeGreaterThan(100);
  return both / either;
}

/** Light layers only: the shadow tests' camera sees the ground, not the casters. */
const CASTERS = 1;

/**
 * The shadow `object` casts from `light` onto a ground seen from above, as coverage:
 * alpha 255 where the ground is darker than lit.
 */
async function shadowOf(object: Object3D, light: DirectionalLight | PointLight): Promise<Uint8Array> {
  renderer.shadowMap.enabled = true;
  object.traverse((node) => {
    node.castShadow = true;
    if (isMesh(node)) node.layers.set(CASTERS);
  });
  light.castShadow = true;
  light.shadow.mapSize.set(512, 512);
  light.shadow.camera.layers.enable(CASTERS);
  const ground = new Mesh(new PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new MeshStandardMaterial({ roughness: 1 }));
  ground.receiveShadow = true;
  const scene = new Scene().add(ground, light, object, new AmbientLight(0xffffff, 0.1));
  if (light instanceof DirectionalLight) scene.add(light.target);
  // A camera of its own every time: three renders a shadow map once a frame per camera.
  const camera = new OrthographicCamera(-6, 6, 6, -6, 0.1, 100);
  camera.position.set(1, 20, 1);
  camera.up.set(0, 0, -1);
  camera.lookAt(1, 0, 1);
  const pixels = await render(scene, camera);
  let lit = 0;
  for (let i = 0; i < pixels.length; i += 4) lit = Math.max(lit, pixels[i] ?? 0);
  for (let i = 0; i < pixels.length; i += 4) pixels[i + 3] = (pixels[i] ?? 0) < lit * 0.8 ? 255 : 0;
  return pixels;
}

describe("Wind", { timeout: GPU_TIMEOUT }, () => {
  it("keeps a transformed source and its impostor together throughout the sway", async () => {
    const source = placed(plant());
    const impostor = placed(new ImpostorMesh(await baked()));
    const wind = new Wind({ direction: [1, 0.4], speed: 0.6 });
    wind.apply(source, { amplitude: 0.9 });
    wind.apply(impostor, { amplitude: 0.9 });
    const frames: Uint8Array[] = [];
    for (const time of [0, 0.37, 1.2]) {
      wind.time = time;
      const real = await render(source);
      frames.push(real);
      expect(overlap(real, await render(impostor))).toBeGreaterThan(0.86);
    }
    const [a, b] = frames;
    if (!a || !b) throw new Error("missing wind frames");
    expect(overlap(a, b)).toBeLessThan(0.95);
    impostor.dispose();
  });

  it("animates real simplified and baked outputs with the same motion as their source", async () => {
    const source = plant(3);
    const simplified = await simplify(source, { ratio: 0.5 });
    const level = await bakeMesh(source, { low: plant(), textureSize: 64 });
    const wind = new Wind({ direction: [1, 0.4], speed: 0.6 });
    for (const object of [source, simplified, level]) wind.apply(placed(object), { amplitude: 0.9, baseY: 0, height: 3 });
    for (const time of [0.2, 0.9]) {
      wind.time = time;
      const real = await render(source, view(), true);
      expect(overlap(real, await render(simplified, view(), true))).toBeGreaterThan(0.97);
      expect(overlap(real, await render(level, view(), true))).toBeGreaterThan(0.97);
    }
    for (const object of [source, simplified, level]) disposeTree(object);
  });

  it.each([false, true])("transforms normals and positions like a sheared real mesh (placed child: %s)", async (placedChild) => {
    const geometry = new BoxGeometry(0.7, 3, 0.7).translate(0, 1.5, 0);
    const material = new MeshStandardMaterial({ color: 0x80b050, roughness: 1 });
    const source = new Mesh(geometry, material);
    if (placedChild) {
      source.position.set(0.4, 0.2, -0.3);
      source.rotation.set(0.2, 0.4, 0.3);
      source.scale.set(1.1, 0.8, 0.7);
    }
    source.updateMatrix();
    const root = placedChild ? new Group().add(source) : source;
    const reference = new Mesh(geometry.clone().applyMatrix4(source.matrix).applyMatrix4(SHEAR()), material);
    const wind = new Wind({ direction: [1, 0], speed: 0.25 });
    wind.apply(root, { amplitude: 0.9, baseY: 0, height: 3 });
    wind.time = 1;
    const actual = await render(root, view(), true);
    const expected = await render(reference, view(), true);
    expect(overlap(actual, expected)).toBeGreaterThan(0.99);
    let error = 0;
    let covered = 0;
    for (let i = 0; i < actual.length; i += 4) {
      if ((actual[i + 3] ?? 0) < 255 || (expected[i + 3] ?? 0) < 255) continue;
      for (let channel = 0; channel < 3; channel++) error += Math.abs((actual[i + channel] ?? 0) - (expected[i + channel] ?? 0));
      covered++;
    }
    expect(covered).toBeGreaterThan(100);
    expect(error / (covered * 3)).toBeLessThan(1);
  });

  it("leaves static siblings' shared material and geometry untouched", () => {
    const geometry = new BoxGeometry(0.5, 3, 0.5).translate(0, 1.5, 0);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const material = new MeshStandardMaterial();
    const moving = new Mesh(geometry, material);
    const still = new Mesh(geometry, material);
    const before = { box: geometry.boundingBox?.clone(), sphere: geometry.boundingSphere?.clone() };
    new Wind().apply(moving, { amplitude: 0.7 });
    expect(still.material).toBe(material);
    expect(still.geometry).toBe(geometry);
    expect(geometry.boundingBox).toEqual(before.box);
    expect(geometry.boundingSphere).toEqual(before.sphere);
    expect(moving.material).not.toBe(material);
    expect(originalOf([moving.material].flat()[0] ?? material)).toBe(material);
  });

  it("changes no LOD choice, fade or instance matrix, only the culling envelope", () => {
    const cube = () => new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial());
    const heights = [410, 399, 381, 359, 101, 99, 95, 89];
    const distance = (pixels: number) => (Math.sqrt(12) * 1080) / (2 * Math.tan(Math.PI / 6) * pixels);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.updateMatrixWorld();
    const wind = new Wind();
    const fades = (lod: Lod) =>
      lod.levels.map(({ object }) => {
        const draw = drawOf(object);
        return draw?.kind === "object" ? draw.fade : null;
      });
    const settings = (lod: Lod | InstancedLod) => lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 400, 100][i] ?? Infinity));

    const still = new Lod([cube(), cube(), cube()]);
    settings(still);
    const moving = still.clone();
    wind.apply(moving, { amplitude: 0.8 });
    for (const height of heights) {
      for (const lod of [still, moving]) {
        lod.position.z = -distance(height);
        lod.updateMatrixWorld();
        lod.update(camera);
      }
      expect(moving.levels.map((level) => level.object.visible)).toEqual(still.levels.map((level) => level.object.visible));
      expect(fades(moving)).toEqual(fades(still));
    }

    const batch = new InstancedLod([cube(), cube(), cube()], heights.length);
    settings(batch);
    heights.forEach((height, i) => batch.setMatrixAt(i, new Matrix4().makeTranslation(0, 0, -distance(height))));
    const swaying = batch.clone();
    for (const lod of [batch, swaying]) {
      lod.updateMatrixWorld();
      lod.update(camera);
    }
    const radius = (lod: InstancedLod) => lod.bounds.radius;
    const before = radius(swaying);
    wind.apply(swaying, { amplitude: 0.8 });
    wind.time = 1.25;
    swaying.update(camera);
    expect(radius(swaying)).toBeGreaterThan(before);
    expect(heights.map((_, i) => swaying.levelOf(i))).toEqual(heights.map((_, i) => batch.levelOf(i)));
    expect(heights.map((_, i) => swaying.getMatrixAt(i, new Matrix4()).elements)).toEqual(heights.map((_, i) => batch.getMatrixAt(i, new Matrix4()).elements));
    for (const lod of [still, moving, batch, swaying]) lod.dispose();
  });

  it("keeps a fade whole when the instances sway", async () => {
    const mesh = () => new Mesh(new BoxGeometry(0.7, 3, 0.7).translate(0, 1.5, 0), new MeshStandardMaterial());
    const lod = new InstancedLod([mesh(), mesh()], 2);
    const coarse = lod.levels[1];
    if (!coarse) throw new Error("missing coarse level");
    coarse.maxPixels = 60;
    const wind = new Wind();
    wind.apply(lod, { amplitude: 0.5 });
    wind.time = 0.7;
    const diameter = Math.hypot(0.7, 3, 0.7);
    const distance = Math.sqrt(((diameter * 128) / (2 * Math.tan(Math.PI / 6) * 60 * (1 - Lod.fade / 2))) ** 2 - 1);
    lod.setMatrixAt(0, new Matrix4().makeTranslation(-1, 0, distance / 2));
    lod.setMatrixAt(1, new Matrix4().makeTranslation(1, 0, 0));
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 1.5, distance);
    camera.lookAt(0, 1.5, 0);
    await render(lod, camera); // Learn this view's viewport height.
    const faded = await render(lod, camera);
    expect([lod.levelOf(0), lod.levelOf(1)]).toEqual([0, 0]);
    lod.forceLevel = 0;
    const whole = await render(lod, camera);
    expect(overlap(faded, whole)).toBeGreaterThan(0.999);
    lod.forceLevel = 1;
    expect(overlap(await render(lod, camera), whole)).toBeGreaterThan(0.999);
    lod.dispose();
  });

  it("frees its swaying materials with the LOD", () => {
    const source = new Mesh(new BoxGeometry(0.7, 3, 0.7), new MeshStandardMaterial());
    const lod = new Lod([source]);
    new Wind().apply(lod, { amplitude: 0.5 });
    let freed = 0;
    [source.material].flat()[0]?.addEventListener("dispose", () => freed++);
    lod.dispose();
    expect(freed).toBe(1);
  });

  it("widens the bounds of instances once, and keeps the envelope when cloned or moved", () => {
    const lod = new InstancedLod([plant()], 1);
    const camera = view();
    lod.updateMatrixWorld();
    lod.update(camera);
    const sphere = () => lod.bounds.clone();
    const radius = sphere().radius;
    new Wind().apply(lod, { amplitude: 0.8 });
    lod.update(camera);
    expect(sphere().radius).toBeGreaterThan(radius);
    const clone = lod.clone();
    clone.updateMatrixWorld();
    clone.update(camera);
    expect(clone.bounds).toEqual(sphere());

    const standalone = new InstancedMesh(new BoxGeometry(0.5, 3, 0.5).translate(0, 1.5, 0), new MeshStandardMaterial(), 1);
    standalone.instanceMatrix = new StorageInstancedBufferAttribute(new Float32Array(new Matrix4().elements), 16);
    standalone.computeBoundingSphere();
    const restRadius = standalone.boundingSphere?.radius ?? 0;
    new Wind().apply(standalone, { amplitude: 0.8 });
    const movingRadius = standalone.boundingSphere?.radius ?? 0;
    expect(movingRadius).toBeGreaterThan(restRadius);
    standalone.setMatrixAt(0, new Matrix4().makeTranslation(10, 0, 0));
    standalone.computeBoundingSphere();
    expect(standalone.boundingSphere?.radius).toBeCloseTo(movingRadius);
    expect(standalone.boundingSphere?.center.x).toBeCloseTo(10);
    expect(() => new Wind().apply(new InstancedMesh(new BoxGeometry(), new MeshStandardMaterial(), 1), { amplitude: 1 })).toThrow(/StorageInstancedBufferAttribute/);
    clone.dispose();
    lod.dispose();
  });

  it("measures drawable fallback levels and respects authored source matrices", async () => {
    const wind = new Wind({ speed: 0.25 });
    const empty = new Lod([new Group(), plant()]);
    expect(() => wind.apply(empty, { amplitude: 0.9 })).not.toThrow();
    const source = plant();
    source.matrixAutoUpdate = false;
    source.matrix.makeTranslation(0, 10, 0);
    source.matrixWorldNeedsUpdate = true;
    const lod = new InstancedLod([source], 1);
    wind.apply(lod, { amplitude: 0.9 });
    wind.time = 1;
    const reference = plant();
    reference.matrixAutoUpdate = false;
    reference.matrix.makeTranslation(0, 10, 0).multiply(SHEAR());
    const camera = view();
    camera.position.y += 10;
    camera.lookAt(2, 11.4, -1);
    const actual = await render(lod, camera);
    const expected = await render(reference, camera);
    expect(overlap(actual, expected)).toBeGreaterThan(0.99);
    lod.dispose();
    empty.dispose();
  });

  it("rejects singular placements before changing any materials or bounds", () => {
    const source = plant();
    const [first, second] = source.children.filter(isMesh);
    if (!first || !second) throw new Error("missing plant meshes");
    const material = first.material;
    const box = first.geometry.boundingBox?.clone() ?? null;
    second.scale.y = 0;
    const wind = new Wind();
    expect(() => wind.apply(source, { amplitude: 0.5 })).toThrow(/invertible/);
    expect(first.material).toBe(material);
    expect(first.geometry.boundingBox).toEqual(box);
    second.scale.y = 1;
    expect(() => wind.apply(source, { amplitude: 0.5 })).not.toThrow();
  });

  it("casts the swayed shape into directional and point-light shadow maps", async () => {
    const reference = plant();
    reference.traverse((node) => {
      if (!isMesh(node)) return;
      node.updateMatrix();
      node.geometry.applyMatrix4(node.matrix).applyMatrix4(SHEAR());
      node.position.set(0, 0, 0);
    });
    const impostor = await baked();
    const referenceImpostor = new ImpostorMesh(impostor);
    referenceImpostor.setMatrixAt(0, SHEAR());
    const wind = new Wind({ direction: [1, 0], speed: 0.25 });
    wind.time = 1;
    // A light of its own for every shadow: a light keeps the map of the scene it last lit.
    const lights: Array<() => DirectionalLight | PointLight> = [
      () => {
        const sun = new DirectionalLight(0xffffff, 3);
        sun.position.set(4, 6, 3);
        sun.target.position.set(0, 1.5, 0);
        Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 0.1, far: 30 });
        sun.shadow.camera.updateProjectionMatrix();
        return sun;
      },
      () => {
        const lamp = new PointLight(0xffffff, 200);
        lamp.position.set(4, 6, 3);
        lamp.shadow.camera.near = 0.1;
        lamp.shadow.camera.far = 30;
        return lamp;
      },
    ];
    for (const light of lights) {
      const source = plant();
      wind.apply(source, { amplitude: 0.9, baseY: 0, height: 3 });
      const swaying = new ImpostorMesh(impostor);
      wind.apply(swaying, { amplitude: 0.9, baseY: 0, height: 3 });
      const type = light().type;
      expect(overlap(await shadowOf(source, light()), await shadowOf(reference, light())), type).toBeGreaterThan(0.97);
      expect(overlap(await shadowOf(swaying, light()), await shadowOf(referenceImpostor, light())), type).toBeGreaterThan(0.95);
      swaying.dispose();
    }
    referenceImpostor.dispose();
  });

  it("keeps wind and its shared clock when cloning each LOD representation", async () => {
    const data = await baked();
    const wind = new Wind({ direction: [1, 0.4], speed: 0.6 });
    const objects = [placed(new Lod([plant(), new ImpostorMesh(data)])), placed(new InstancedLod([plant(), new ImpostorMesh(data)], 1)), placed(new ImpostorMesh(data))];
    for (const object of objects) {
      wind.apply(object, { amplitude: 0.9 });
      const clone = object.clone();
      const levels = "forceLevel" in object ? [0, 1] : [0];
      for (const level of levels) {
        if ("forceLevel" in object && "forceLevel" in clone) object.forceLevel = clone.forceLevel = level;
        const frames: Uint8Array[] = [];
        for (const time of [0.2, 0.9]) {
          wind.time = time;
          const pixels = await render(object);
          frames.push(pixels);
          expect(overlap(pixels, await render(clone))).toBeGreaterThan(0.99);
        }
        const [a, b] = frames;
        if (!a || !b) throw new Error("missing cloned wind frames");
        expect(overlap(a, b)).toBeLessThan(0.95);
      }
      clone.dispose();
      object.dispose();
    }
  });
});

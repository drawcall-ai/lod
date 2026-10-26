import {
  AmbientLight,
  DirectionalLight,
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  Scene,
  WebGLRenderTarget,
  type Object3D,
} from "three";
import { describe, expect, it } from "vitest";
import { bakeMesh } from "../src/baked/index.js";
import { fadeUniformsOf } from "../src/fade.js";
import { disposeTree } from "../src/dispose.js";
import { simplify } from "../src/simplify.js";
import { bakeImpostor } from "../src/impostor/bake/index.js";
import type { Impostor } from "../src/impostor/impostor.js";
import { ImpostorMesh } from "../src/impostor/mesh/index.js";
import { InstancedLod } from "../src/instanced/index.js";
import { Lod } from "../src/lod.js";
import { isInstancedMesh, isMesh } from "../src/three.js";
import { Wind } from "../src/wind/index.js";
import { GPU_TIMEOUT, renderer } from "./webgl.js";

/** Asymmetric, with a child transform: every part must use the same root-space sway. */
function plant(segments = 1): Group {
  const trunk = new Mesh(new BoxGeometry(0.4, 3, 0.4, segments, segments, segments), new MeshStandardMaterial());
  trunk.position.y = 1.5;
  const branch = new Mesh(new BoxGeometry(1.1, 0.5, 0.6, segments, segments, segments), new MeshStandardMaterial());
  branch.position.set(0.55, 2.3, 0.1);
  return new Group().add(trunk, branch);
}

let atlas: Promise<Impostor> | undefined;
const baked = () => (atlas ??= bakeImpostor(plant(), { renderer, resolution: 128, layout: "full" }));

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

function render(object: Object3D, camera = view(), lit = false): Uint8Array {
  const target = new WebGLRenderTarget(128, 128, { samples: 4 });
  const scene = new Scene().add(object);
  if (lit) {
    const light = new DirectionalLight(0xffffff, 2);
    light.position.set(4, 5, 3);
    scene.add(light, new AmbientLight(0xffffff, 0.2));
  }
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  const pixels = new Uint8Array(128 * 128 * 4);
  renderer.readRenderTargetPixels(target, 0, 0, 128, 128, pixels);
  renderer.setRenderTarget(null);
  target.dispose();
  scene.remove(object);
  return pixels;
}

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
      const real = render(source);
      frames.push(real);
      expect(overlap(real, render(impostor))).toBeGreaterThan(0.86);
    }
    const [a, b] = frames;
    if (!a || !b) throw new Error("missing wind frames");
    expect(overlap(a, b)).toBeLessThan(0.95);
    impostor.dispose();
  });

  it("animates real simplified and baked outputs with the same motion as their source", async () => {
    const source = plant(3);
    const simplified = await simplify(source, { ratio: 0.5 });
    const baked = await bakeMesh(source, { low: plant(), textureSize: 64 });
    const wind = new Wind({ direction: [1, 0.4], speed: 0.6 });
    for (const object of [source, simplified, baked]) wind.apply(placed(object), { amplitude: 0.9, baseY: 0, height: 3 });
    for (const time of [0.2, 0.9]) {
      wind.time = time;
      const real = render(source, view(), true);
      expect(overlap(real, render(simplified, view(), true))).toBeGreaterThan(0.97);
      expect(overlap(real, render(baked, view(), true))).toBeGreaterThan(0.97);
    }
    for (const object of [source, simplified, baked]) disposeTree(object);
  });

  it.each([false, true])("transforms normals and positions like a sheared real mesh (placed child: %s)", (placedChild) => {
    const geometry = new BoxGeometry(0.7, 3, 0.7).translate(0, 1.5, 0);
    const material = new MeshStandardMaterial({
      color: 0x80b050,
      roughness: 1,
    });
    const source = new Mesh(geometry, material);
    if (placedChild) {
      source.position.set(0.4, 0.2, -0.3);
      source.rotation.set(0.2, 0.4, 0.3);
      source.scale.set(1.1, 0.8, 0.7);
    }
    source.updateMatrix();
    const root = placedChild ? new Group().add(source) : source;
    const shear = new Matrix4().makeShear(0, 0, 0.3, 0, 0, 0);
    const reference = new Mesh(geometry.clone().applyMatrix4(source.matrix).applyMatrix4(shear), material);
    const wind = new Wind({ direction: [1, 0], speed: 0.25 });
    wind.apply(root, { amplitude: 0.9, baseY: 0, height: 3 });
    wind.time = 1;
    const actual = render(root, view(), true);
    const expected = render(reference, view(), true);
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

  it("leaves static siblings' shared material, geometry and shader untouched", () => {
    const geometry = new BoxGeometry(0.5, 3, 0.5).translate(0, 1.5, 0);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const material = new MeshStandardMaterial();
    const moving = new Mesh(geometry, material);
    const still = new Mesh(geometry, material);
    const before = {
      box: geometry.boundingBox?.clone(),
      sphere: geometry.boundingSphere?.clone(),
      compile: material.onBeforeCompile,
      key: material.customProgramCacheKey(),
    };
    new Wind().apply(moving, { amplitude: 0.7 });
    expect(still.material).toBe(material);
    expect(still.geometry).toBe(geometry);
    expect(material.onBeforeCompile).toBe(before.compile);
    expect(material.customProgramCacheKey()).toBe(before.key);
    expect(geometry.boundingBox).toEqual(before.box);
    expect(geometry.boundingSphere).toEqual(before.sphere);
    expect(moving.material).not.toBe(material);
    expect(still.customDepthMaterial).toBeUndefined();
    expect(still.customDistanceMaterial).toBeUndefined();
  });

  it("animates instances without touching their matrices, slots or selection", () => {
    const lod = new InstancedLod([plant(), plant()], 2);
    lod.setMatrixAt(0, new Matrix4().makeTranslation(-1, 0, 0));
    lod.setMatrixAt(1, new Matrix4().makeTranslation(2, 0, -30));
    const wind = new Wind();
    wind.apply(lod, { amplitude: 0.4 });
    const camera = view();
    camera.updateMatrixWorld();
    lod.updateMatrixWorld();
    lod.update(camera);
    const meshes = lod.children.filter(isInstancedMesh);
    const state = () => meshes.map((mesh) => ({ version: mesh.instanceMatrix.version, count: mesh.count, data: mesh.instanceMatrix.array.slice() }));
    const before = state();
    const selection = [lod.levelOf(0), lod.levelOf(1)];
    wind.time = 1.25;
    lod.update(camera);
    expect(state()).toEqual(before);
    expect([lod.levelOf(0), lod.levelOf(1)]).toEqual(selection);
    lod.dispose();
  });

  it("expands culling without changing static LOD choices or fade thresholds", () => {
    const cube = () => new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial());
    const heights = [410, 399, 381, 359, 101, 99, 95, 89];
    const distance = (pixels: number) => (Math.sqrt(12) * 1080) / (2 * Math.tan(Math.PI / 6) * pixels);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.updateMatrixWorld();
    const wind = new Wind();
    const boundsAndFades = (root: Object3D) =>
      root.children.filter(isMesh).flatMap((mesh) =>
        [mesh.material].flat().map((material) => {
          const uniforms = fadeUniformsOf(material);
          if (!uniforms) throw new Error("missing fade uniforms");
          return [uniforms.lodFadeSphere.value.toArray(), uniforms.lodFade.value.toArray()];
        }),
      );
    const settings = (lod: Lod | InstancedLod) => {
      lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 400, 100][i] ?? Infinity));
    };

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
      expect(boundsAndFades(moving)).toEqual(boundsAndFades(still));
    }

    const batch = new InstancedLod([cube(), cube(), cube()], heights.length);
    settings(batch);
    heights.forEach((height, i) => batch.setMatrixAt(i, new Matrix4().makeTranslation(0, 0, -distance(height))));
    const swaying = batch.clone();
    // A batch that already sorted must refresh only its culling envelope when wind is attached.
    swaying.updateMatrixWorld();
    swaying.update(camera);
    const matrices = swaying.children.filter(isInstancedMesh).map((mesh) => mesh.instanceMatrix.version);
    const beforeRadii = swaying.children.filter(isInstancedMesh).map((mesh) => mesh.boundingSphere?.radius ?? 0);
    wind.apply(swaying, { amplitude: 0.8 });
    swaying.children.filter(isInstancedMesh).forEach((mesh, i) => expect(mesh.boundingSphere?.radius).toBeGreaterThan(beforeRadii[i] ?? 0));
    for (const lod of [batch, swaying]) {
      lod.updateMatrixWorld();
      lod.update(camera);
    }
    expect(swaying.children.filter(isInstancedMesh).map((mesh) => mesh.instanceMatrix.version)).toEqual(matrices);
    expect(swaying.levels.map((level) => level.count)).toEqual(batch.levels.map((level) => level.count));
    expect(heights.map((_, i) => swaying.levelOf(i))).toEqual(heights.map((_, i) => batch.levelOf(i)));
    expect(boundsAndFades(swaying)).toEqual(boundsAndFades(batch));
    const radii = batch.children.filter(isInstancedMesh).map((mesh) => mesh.boundingSphere?.radius ?? 0);
    swaying.children.filter(isInstancedMesh).forEach((mesh, i) => expect(mesh.boundingSphere?.radius).toBeGreaterThan(radii[i] ?? 0));
    for (const lod of [still, moving, batch, swaying]) lod.dispose();
  });

  it("keeps a fade whole and phase stable when the same instance changes draw slots", () => {
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
    render(lod, camera); // Learn this view's viewport height.
    const faded = render(lod, camera);
    expect(lod.levels.map((level) => level.count)).toEqual([2, 1]);
    lod.forceLevel = 0;
    const whole = render(lod, camera);
    expect(overlap(faded, whole)).toBeGreaterThan(0.999);
    // The coarse list held instance 1 first; forcing it appends instance 0 after it.
    lod.forceLevel = 1;
    expect(overlap(render(lod, camera), whole)).toBeGreaterThan(0.999);
    lod.forceLevel = null;
    expect(overlap(render(lod, camera), whole)).toBeGreaterThan(0.999);
    lod.dispose();
  });

  it("disposes wind's shadow materials and replaced fade copies with the LOD", () => {
    const source = new Mesh(new BoxGeometry(0.7, 3, 0.7), new MeshStandardMaterial());
    const lod = new Lod([source]);
    let faded = 0;
    let shadows = 0;
    source.material.addEventListener("dispose", () => faded++);
    new Wind().apply(lod, { amplitude: 0.5 });
    source.customDepthMaterial?.addEventListener("dispose", () => shadows++);
    source.customDistanceMaterial?.addEventListener("dispose", () => shadows++);
    lod.dispose();
    expect(faded).toBe(1);
    expect(shadows).toBe(2);
  });

  it("refreshes existing instance bounds once and preserves the envelope when cloned or moved", () => {
    const lod = new InstancedLod([plant()], 1);
    const camera = view();
    camera.updateMatrixWorld();
    lod.updateMatrixWorld();
    lod.update(camera);
    const mesh = lod.children.find(isInstancedMesh);
    if (!mesh?.boundingSphere) throw new Error("missing instance bounds");
    const radius = mesh.boundingSphere.radius;
    new Wind().apply(lod, { amplitude: 0.8 });
    lod.update(camera);
    expect(mesh.boundingSphere.radius).toBeGreaterThan(radius);
    const clone = lod.clone();
    clone.updateMatrixWorld();
    clone.update(camera);
    expect(clone.children.find(isInstancedMesh)?.boundingSphere).toEqual(mesh.boundingSphere);

    const standalone = new InstancedMesh(new BoxGeometry(0.5, 3, 0.5).translate(0, 1.5, 0), new MeshStandardMaterial(), 1);
    standalone.computeBoundingSphere();
    const restRadius = standalone.boundingSphere?.radius ?? 0;
    new Wind().apply(standalone, { amplitude: 0.8 });
    const movingRadius = standalone.boundingSphere?.radius ?? 0;
    expect(movingRadius).toBeGreaterThan(restRadius);
    standalone.setMatrixAt(0, new Matrix4().makeTranslation(10, 0, 0));
    standalone.computeBoundingSphere();
    expect(standalone.boundingSphere?.radius).toBeCloseTo(movingRadius);
    expect(standalone.boundingSphere?.center.x).toBeCloseTo(10);
    clone.dispose();
    lod.dispose();
  });

  it("measures drawable fallback levels and respects authored source matrices", () => {
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
    reference.matrix.makeTranslation(0, 10, 0).multiply(new Matrix4().makeShear(0, 0, 0.3, 0, 0, 0));
    const camera = view();
    camera.position.y += 10;
    camera.lookAt(2, 11.4, -1);
    const actual = render(lod, camera);
    const expected = render(reference, camera);
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
    expect(first.customDepthMaterial).toBeUndefined();
    second.scale.y = 1;
    expect(() => wind.apply(source, { amplitude: 0.5 })).not.toThrow();
  });

  it("casts the deformed shape into directional and point-light shadow maps", async () => {
    const source = plant();
    const impostor = new ImpostorMesh(await baked());
    const referenceImpostor = new ImpostorMesh(impostor.impostor);
    referenceImpostor.setMatrixAt(0, new Matrix4().makeShear(0, 0, 0.3, 0, 0, 0));
    const reference = plant();
    reference.traverse((node) => {
      if (!isMesh(node)) return;
      node.updateMatrix();
      node.geometry.applyMatrix4(node.matrix).applyMatrix4(new Matrix4().makeShear(0, 0, 0.3, 0, 0, 0));
      node.position.set(0, 0, 0);
    });
    const wind = new Wind({ direction: [1, 0], speed: 0.25 });
    wind.apply(source, { amplitude: 0.9, baseY: 0, height: 3 });
    wind.apply(impostor, { amplitude: 0.9, baseY: 0, height: 3 });
    wind.time = 1;
    for (const object of [source, impostor, reference, referenceImpostor]) {
      object.traverse((node) => {
        node.castShadow = true;
      });
    }
    const enabled = renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = true;
    try {
      for (const light of [new DirectionalLight(), new PointLight()]) {
        light.position.set(4, 6, 3);
        light.castShadow = true;
        light.shadow.mapSize.set(128, 128);
        light.shadow.camera.near = 0.1;
        light.shadow.camera.far = 30;
        if (light instanceof DirectionalLight) light.target.position.set(0, 1.5, 0);
        const shadow = (object: Object3D) => {
          const scene = new Scene().add(object, light);
          if (light instanceof DirectionalLight) scene.add(light.target);
          const target = new WebGLRenderTarget(64, 64);
          renderer.setRenderTarget(target);
          renderer.render(scene, view());
          const map = light.shadow.map;
          if (!(map instanceof WebGLRenderTarget)) throw new Error("no WebGL shadow map rendered");
          const faces = light instanceof PointLight ? 6 : 1;
          const size = map.width * map.height * 4;
          const pixels = new Uint8Array(size * faces);
          for (let face = 0; face < faces; face++)
            renderer.readRenderTargetPixels(map, 0, 0, map.width, map.height, pixels.subarray(face * size, (face + 1) * size), face);
          renderer.setRenderTarget(null);
          target.dispose();
          scene.remove(object, light);
          // Shadow targets clear to white; every other depth is a covered texel.
          for (let i = 0; i < pixels.length; i += 4) pixels[i + 3] = pixels.subarray(i, i + 4).some((value) => value < 250) ? 255 : 0;
          return pixels;
        };
        const expected = shadow(reference);
        expect(overlap(shadow(source), expected), light.type).toBeGreaterThan(0.99);
        expect(overlap(shadow(impostor), shadow(referenceImpostor)), light.type).toBeGreaterThan(0.99);
        light.shadow.dispose();
      }
    } finally {
      renderer.shadowMap.enabled = enabled;
    }
    impostor.dispose();
    referenceImpostor.dispose();
  });

  it("keeps wind and its shared clock when cloning each LOD representation", async () => {
    const data = await baked();
    const wind = new Wind({ direction: [1, 0.4], speed: 0.6 });
    const objects = [
      placed(new Lod([plant(), new ImpostorMesh(data)])),
      placed(new InstancedLod([plant(), new ImpostorMesh(data)], 1)),
      placed(new ImpostorMesh(data)),
    ];
    for (const object of objects) {
      wind.apply(object, { amplitude: 0.9 });
      const clone = object.clone();
      const levels = "forceLevel" in object ? [0, 1] : [0];
      for (const level of levels) {
        if ("forceLevel" in object && "forceLevel" in clone) object.forceLevel = clone.forceLevel = level;
        const frames: Uint8Array[] = [];
        for (const time of [0.2, 0.9]) {
          wind.time = time;
          const pixels = render(object);
          frames.push(pixels);
          expect(overlap(pixels, render(clone))).toBeGreaterThan(0.99);
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

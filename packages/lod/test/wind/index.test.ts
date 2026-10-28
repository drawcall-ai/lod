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
import { drawOf } from "../../src/fade.js";
import { bakeImpostor } from "../../src/impostor/bake/index.js";
import type { Impostor } from "../../src/impostor/impostor.js";
import { ImpostorMesh } from "../../src/impostor/mesh/index.js";
import { InstancedLod } from "../../src/instanced/index.js";
import { Lod } from "../../src/lod.js";
import { readBytes } from "../../src/renderer.js";
import { isMesh } from "../../src/three.js";
import { Wind } from "../../src/wind/index.js";
import { GPU_TIMEOUT, renderer } from "../gpu.js";

/** Asymmetric, with a child transform: every part must use the same root-space sway. */
function plant(): Group {
  const trunk = new Mesh(new BoxGeometry(0.4, 3, 0.4), new MeshStandardMaterial());
  trunk.position.y = 1.5;
  const branch = new Mesh(new BoxGeometry(1.1, 0.5, 0.6), new MeshStandardMaterial());
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
  it("shares the wind shader while keeping separate breeze clocks", async () => {
    const first = new ImpostorMesh(await baked());
    const second = first.clone();
    const a = new Wind();
    const b = new Wind();
    a.apply(first, { amplitude: 0.9 });
    const version = first.material.version;
    const deformation = first.material.deformNode;
    b.apply(second, { amplitude: 0.9 });
    expect(first.material.version).toBe(version);
    expect(second.material.deformNode).toBe(deformation);
    a.time = 1;
    const moving = await render(first);
    expect(overlap(moving, await render(second))).toBeLessThan(0.95);
    b.time = 1;
    expect(overlap(moving, await render(second))).toBeGreaterThan(0.99);
    for (const object of [first, second]) object.dispose();
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

  it("keeps Lod selection and fades based on the resting source size", () => {
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
    const still = new Lod([cube(), cube(), cube()]);
    still.levels.forEach((level, i) => (level.maxPixels = [Infinity, 400, 100][i] ?? Infinity));
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

    still.dispose();
    moving.dispose();
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

  it("keeps standalone instance bounds padded after the matrices change", () => {
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
    expect(() => new Wind().apply(new InstancedMesh(new BoxGeometry(), new MeshStandardMaterial(), 1), { amplitude: 1 })).toThrow(
      /StorageInstancedBufferAttribute/,
    );
    standalone.geometry.dispose();
    standalone.material.dispose();
  });

  it("measures authored source matrices when inferring the sway base", async () => {
    const wind = new Wind({ speed: 0.25 });
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

  it("keeps transformed sources, impostors and their clones together on the shared clock", async () => {
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
      const sourceFrames: Uint8Array[] = [];
      for (const level of levels) {
        if ("forceLevel" in object && "forceLevel" in clone) object.forceLevel = clone.forceLevel = level;
        const frames: Uint8Array[] = [];
        for (const time of [0.2, 0.9]) {
          wind.time = time;
          const pixels = await render(object);
          if (level === 0) sourceFrames.push(pixels);
          else {
            const source = sourceFrames[frames.length];
            if (!source) throw new Error("missing source frame");
            expect(overlap(pixels, source)).toBeGreaterThan(0.86);
          }
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

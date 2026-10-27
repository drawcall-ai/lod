import * as THREE from "three/webgpu";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { InstancedLod, Lod, LodLoader } from "@drawcall/lod";
import { readBytes } from "../../../packages/lod/src/renderer.js";
import { at } from "./must.js";
import { gltfLoader, gpuName, gpuRenderer, nextFrame, png } from "./page.js";

// Standalone page (instanced.html): InstancedLod of a real tree, driven by
// scripts/instanced.ts through window.instanced.
//
// - perf(count): `count` trees on a grid; per camera view the CPU time of an update and
//   of a frame's render call, and the GPU time of a frame (timestamp queries over every
//   pass, the selection included).
// - compare(): a small grid drawn as one InstancedLod and as one Lod per tree at the
//   same placement, from a view where trees sit in every level and fade; the images
//   must match.
// - cascades(count): `count` trees and as many bushes, seen from the ground under a sun
//   with two shadow maps like a cascade pair: a fine one around the camera and a coarse
//   one far ahead, whose texels are wider than a bush. GPU time of a frame with both maps
//   drawn every frame.

const SIZE = 1024;
const SPACING = 12;
const renderer = await gpuRenderer(SIZE, { timed: true });
renderer.shadowMap.enabled = true;
const target = new THREE.RenderTarget(SIZE, SIZE, { samples: 4 });

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb3c8);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.4;
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.position.set(-60, 100, 40);
scene.add(sun, new THREE.HemisphereLight(0xdfe8ff, 0x4a5a3a, 0.8));
const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 20000);

const manager = new THREE.LoadingManager();
manager.addHandler(/\.glb$/i, gltfLoader(manager));
const loader = new LodLoader(manager);

let template: Lod | null = null;
async function tree(): Promise<Lod> {
  template ??= await loader.loadAsync({
    url: "/models/CommonTree_3.glb",
    levels: [
      { type: "simplified", ratio: 0.2, maxPixels: 300 },
      { type: "impostor", layout: "hemi", maxPixels: 120 },
    ],
  });
  return template;
}

let bushTemplate: Lod | null = null;
async function bush(): Promise<Lod> {
  bushTemplate ??= await loader.loadAsync({ url: "/models/Bush_Common_Flowers.glb", levels: [{ type: "impostor", layout: "hemi" }] });
  return bushTemplate;
}

/** Placement of tree `i` of `count` on a square grid around the origin, turned by a hash. */
function placement(i: number, count: number, out: THREE.Matrix4): THREE.Matrix4 {
  const side = Math.ceil(Math.sqrt(count));
  const x = ((i % side) - side / 2) * SPACING;
  const z = (Math.floor(i / side) - side / 2) * SPACING;
  const yaw = (((i * 2654435761) % 1000) / 1000) * Math.PI * 2;
  return out.makeRotationY(yaw).setPosition(x, 0, z);
}

function instanced(source: Lod, count: number, offset = 0): InstancedLod {
  const lod = new InstancedLod(
    source.levels.map((level) => level.object),
    count,
  );
  lod.levels.forEach((level, i) => (level.maxPixels = at(source.levels, i).maxPixels));
  const matrix = new THREE.Matrix4();
  const shift = new THREE.Matrix4().makeTranslation(offset, 0, offset);
  for (let i = 0; i < count; i++) lod.setMatrixAt(i, placement(i, count, matrix).premultiply(shift));
  return lod;
}

async function frame(): Promise<Uint8Array> {
  await nextFrame(renderer);
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  return readBytes(renderer, target, 0);
}

/** GPU time of one frame (every pass and the selection), median over `frames`, from timestamp queries. */
async function gpuTime(frames = 40): Promise<number> {
  if (!renderer.hasFeature("timestamp-query")) throw new Error("instanced GPU timing needs the GPU's timestamp-query feature");
  const times: number[] = [];
  await renderer.resolveTimestampsAsync("render");
  await renderer.resolveTimestampsAsync("compute");
  for (let i = 0; i < frames; i++) {
    await nextFrame(renderer);
    const computed = renderer.info.compute.calls;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    const [passes, selection] = await Promise.all([
      renderer.resolveTimestampsAsync("render"),
      renderer.info.compute.calls > computed ? renderer.resolveTimestampsAsync("compute") : Promise.resolve(0),
    ]);
    times.push((passes ?? 0) + (selection ?? 0));
  }
  times.sort((a, b) => a - b);
  return at(times, Math.floor(times.length / 2));
}

/** CPU time of a frame's render call, mean over `frames`: listing the scene, updating the LODs and encoding the draws, shadow maps included. */
async function cpuTime(frames = 40): Promise<number> {
  let total = 0;
  for (let i = 0; i < frames; i++) {
    await nextFrame(renderer);
    renderer.setRenderTarget(target);
    const start = performance.now();
    renderer.render(scene, camera);
    total += performance.now() - start;
    renderer.setRenderTarget(null);
  }
  return total / frames;
}

const VIEWS: Record<string, { eye: [number, number, number]; look: [number, number, number] }> = {
  ground: { eye: [3, 2, 3], look: [200, 8, 200] },
  above: { eye: [0, 400, 600], look: [0, 0, 0] },
  far: { eye: [0, 1500, 3500], look: [0, 0, 0] },
};

async function perf(count: number) {
  const source = await tree();
  const lod = instanced(source, count);
  scene.add(lod);
  const results: Record<string, { updateMs: number; renderMs: number; gpuMs: number; drawn: number[] }> = {};
  for (const [name, view] of Object.entries(VIEWS)) {
    camera.position.set(...view.eye);
    camera.lookAt(...view.look);
    camera.updateMatrixWorld();
    await frame();
    await frame();
    // CPU of update while the camera moves 5 metres per frame; timers are coarse, the
    // mean over many frames resolves finer.
    const start = camera.position.clone();
    const direction = new THREE.Vector3(1, 0, 1).normalize();
    const updates = 100;
    const t = performance.now();
    for (let i = 0; i < updates; i++) {
      camera.position.addScaledVector(direction, 5);
      camera.updateMatrixWorld();
      lod.update(camera);
    }
    const updateMs = (performance.now() - t) / updates;
    camera.position.copy(start);
    camera.updateMatrixWorld();
    await frame();
    results[name] = { updateMs, renderMs: await cpuTime(), gpuMs: await gpuTime(), drawn: lod.levels.map((_, l) => countAt(lod, l)) };
  }
  // Not disposed: its levels are the template's, which the next run uses again.
  scene.remove(lod);
  return { renderer: await gpuName(), count, results };
}

/** Instances at level `l` (the finest each draws) after the last update, counted on the CPU. */
function countAt(lod: InstancedLod, l: number): number {
  let n = 0;
  for (let i = 0; i < lod.count; i++) if (lod.levelOf(i) === l) n++;
  return n;
}

/** A shadow-casting sun light whose map covers `radius` m around `centre`, `size` texels a side. */
function cascade(centre: THREE.Vector3, radius: number, size: number): THREE.DirectionalLight {
  const light = new THREE.DirectionalLight(0xffffff, 0);
  light.castShadow = true;
  light.shadow.mapSize.set(size, size);
  const cam = light.shadow.camera;
  cam.left = cam.bottom = -radius;
  cam.right = cam.top = radius;
  cam.near = 0;
  cam.far = 2 * radius + 200;
  cam.updateProjectionMatrix();
  light.target.position.copy(centre);
  light.position.copy(centre).addScaledVector(sun.position.clone().normalize(), radius + 100);
  light.updateMatrixWorld();
  light.target.updateMatrixWorld();
  return light;
}

async function cascades(count: number) {
  const lods = [instanced(await tree(), count), instanced(await bush(), count, SPACING / 2)];
  for (const lod of lods) lod.traverse((node) => (node.castShadow = node.receiveShadow = true));
  camera.position.set(3, 2, 3);
  camera.lookAt(200, 8, 200);
  camera.updateMatrixWorld();
  const ahead = new THREE.Vector3(1, 0, 1).normalize();
  // A fine map around the camera; a coarse one 4 km wide from 300 m ahead on (4 m texels).
  const lights = [cascade(new THREE.Vector3(30, 0, 30), 60, 2048), cascade(ahead.clone().multiplyScalar(2300), 2000, 1024)];
  scene.add(...lods, ...lights, ...lights.map((l) => l.target));
  await frame();
  await frame();
  const gpuMs = await gpuTime();
  const renderMs = await cpuTime();
  const drawn = lods.map((lod) => lod.levels.map((_, l) => countAt(lod, l)));
  scene.remove(...lods, ...lights, ...lights.map((l) => l.target));
  for (const light of lights) light.dispose();
  return { renderer: await gpuName(), count, gpuMs, renderMs, drawn };
}

async function compare() {
  const source = await tree();
  const count = 100;
  const lod = instanced(source, count);
  const single = new THREE.Group();
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    const one = source.clone();
    placement(i, count, matrix).decompose(one.position, one.quaternion, one.scale);
    single.add(one);
  }
  // Down a row of the 10 × 10 grid from 20 m before it, so trees sit in every level
  // and in both fades.
  camera.position.set(-80, 6, 0);
  camera.lookAt(60, 6, 0);
  camera.updateMatrixWorld();
  const render = async (object: THREE.Object3D) => {
    scene.add(object);
    await frame();
    const pixels = await frame();
    scene.remove(object);
    return pixels;
  };
  const a = await render(lod);
  const b = await render(single);
  let differing = 0;
  let max = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(at(a, i + c) - at(b, i + c)));
    if (d > 8) differing++;
    max = Math.max(max, d);
  }
  const drawn = lod.levels.map((_, l) => countAt(lod, l));
  return { drawn, differing: differing / (SIZE * SIZE), max, images: { instanced: png(a, SIZE, SIZE), single: png(b, SIZE, SIZE) } };
}

declare global {
  interface Window {
    instanced: { perf: typeof perf; compare: typeof compare; cascades: typeof cascades };
  }
}
window.instanced = { perf, compare, cascades };

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { InstancedLod, Lod, LodLoader } from "@drawcall/lod";
import { at } from "./must.js";
import { gltfLoader, gpuName, png } from "./page.js";

// Standalone page (instanced.html): InstancedLod of a real tree, driven by
// scripts/instanced.ts through window.instanced.
//
// - perf(count): `count` trees on a grid; per camera view the CPU time of a re-sort
//   (update with a moved camera) and the GPU time of a frame (timer queries).
// - compare(): a small grid drawn as one InstancedLod and as one Lod per tree at the
//   same placement, from a view where trees sit in every level and fade; the images
//   must match.
// - cascades(count): `count` trees and as many bushes, seen from the ground under a sun
//   with two shadow maps like a cascade pair: a fine one around the camera and a coarse
//   one far ahead, whose texels are wider than a bush. GPU time and triangles of a frame
//   with both maps drawn every frame.

const SIZE = 1024;
const SPACING = 12;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE);
renderer.shadowMap.enabled = true;
document.body.append(renderer.domElement);
const target = new THREE.WebGLRenderTarget(SIZE, SIZE, { samples: 4 });

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

function frame(): Uint8Array {
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  renderer.readRenderTargetPixels(target, 0, 0, SIZE, SIZE, pixels);
  renderer.setRenderTarget(null);
  return pixels;
}

/** GPU time of one frame, median over `frames`, via timer queries. */
async function gpuTime(frames = 40): Promise<number> {
  const gl = renderer.getContext();
  if (!(gl instanceof WebGL2RenderingContext)) throw new Error("WebGL2 needed");
  const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  if (!timer) throw new Error("GPU timer queries unavailable");
  const queries: WebGLQuery[] = [];
  for (let i = 0; i < frames; i++) {
    const query = gl.createQuery();
    gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    renderer.render(scene, camera);
    gl.endQuery(timer.TIME_ELAPSED_EXT);
    queries.push(query);
    await new Promise(requestAnimationFrame);
  }
  const times: number[] = [];
  for (const query of queries) {
    while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) await new Promise(requestAnimationFrame);
    if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) times.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
    gl.deleteQuery(query);
  }
  times.sort((a, b) => a - b);
  return at(times, Math.floor(times.length / 2));
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
  const results: Record<string, { slowMs: number; fastMs: number; gpuMs: number; drawn: number[] }> = {};
  for (const [name, view] of Object.entries(VIEWS)) {
    camera.position.set(...view.eye);
    camera.lookAt(...view.look);
    camera.updateMatrixWorld();
    frame();
    frame();
    // CPU of update while the camera moves `step` metres per frame (walking ~0.05, flying ~5).
    const moving = (step: number) => {
      const start = camera.position.clone();
      // Timers are coarse (0.1 ms); the mean over many frames resolves finer.
      const frames = 100;
      const direction = new THREE.Vector3(1, 0, 1).normalize();
      let total = 0;
      for (let i = 0; i < frames; i++) {
        camera.position.addScaledVector(direction, step);
        camera.updateMatrixWorld();
        const t = performance.now();
        lod.update(camera);
        total += performance.now() - t;
      }
      camera.position.copy(start);
      camera.updateMatrixWorld();
      lod.update(camera);
      return total / frames;
    };
    const slowMs = moving(0.05);
    const fastMs = moving(5);
    const drawn = lod.children.flatMap((child) => (child instanceof THREE.InstancedMesh ? [child.count] : []));
    results[name] = { slowMs, fastMs, gpuMs: await gpuTime(), drawn };
  }
  // Not disposed: its levels are the template's, which the next run uses again.
  scene.remove(lod);
  return { renderer: rendererName(), count, results };
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
  frame();
  frame();
  const gpuMs = await gpuTime();
  renderer.render(scene, camera);
  const triangles = renderer.info.render.triangles;
  const drawn = lods.map((lod) => lod.levels.map((level) => level.count));
  scene.remove(...lods, ...lights, ...lights.map((l) => l.target));
  for (const light of lights) light.dispose();
  return { renderer: rendererName(), count, gpuMs, drawn, triangles };
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
  const render = (object: THREE.Object3D) => {
    scene.add(object);
    frame();
    const pixels = frame();
    scene.remove(object);
    return pixels;
  };
  const a = render(lod);
  const b = render(single);
  let differing = 0;
  let max = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(at(a, i + c) - at(b, i + c)));
    if (d > 8) differing++;
    max = Math.max(max, d);
  }
  const drawn = lod.children.flatMap((child) => (child instanceof THREE.InstancedMesh ? [child.count] : []));
  return { drawn, differing: differing / (SIZE * SIZE), max, images: { instanced: png(a, SIZE, SIZE), single: png(b, SIZE, SIZE) } };
}

const rendererName = () => gpuName(renderer.getContext());

declare global {
  interface Window {
    instanced: { perf: typeof perf; compare: typeof compare; cascades: typeof cascades };
  }
}
window.instanced = { perf, compare, cascades };

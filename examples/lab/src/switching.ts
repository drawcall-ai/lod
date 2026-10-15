import * as THREE from "three";
import { Lod, LodLoader } from "@drawcall/lod";
import { boundingSphere } from "../../../packages/lod/src/bounds.js";
import { FADE } from "../../../packages/lod/src/levels.js";
import { at, must } from "./must.js";
import { gltfLoader, gpuName } from "./page.js";
import { pixelsOf } from "./pixels.js";

// Standalone page (switching.html): a Lod of a real model, loaded through LodLoader,
// rendered across distances. Driven by scripts/switching.ts through window.switching.run().
//
// - levels: exactly the expected level(s) are visible at each on-screen height.
// - shadows: with the model itself invisible (colorWrite off), the shadow of the chosen
//   level is all that shows; it must equal the shadow with that level forced, and differ
//   from the source's shadow.
// - pop: mean pixel change between consecutive 0.5% distance steps through both
//   fades, as a ratio to the steps around it, against the same sweep with levels
//   swapped at once (forceLevel).

const SIZE = 512;
const MAX_PIXELS = [Infinity, 300, 120];

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE);
renderer.shadowMap.enabled = true;
document.body.append(renderer.domElement);
// Read back from a multisampled target: the canvas would keep alpha-to-coverage alpha.
const target = new THREE.WebGLRenderTarget(SIZE, SIZE, { samples: 4 });

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fa3b8);
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x4a5a3a, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun, sun.target);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x7d8a64 }));
ground.receiveShadow = true;
scene.add(ground);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));

function frame(): Uint8Array {
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  renderer.readRenderTargetPixels(target, 0, 0, SIZE, SIZE, pixels);
  renderer.setRenderTarget(null);
  return pixels;
}

/** Mean absolute RGB difference, 0..255. */
function difference(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) sum += Math.abs(at(a, i + c) - at(b, i + c));
  return sum / ((a.length / 4) * 3);
}

/** Levels a Lod should show at `pixels` tall (after Lod.quality), for shrinking maxPixels. */
function expected(pixels: number, levels: number[]): number[] {
  let chosen = 0;
  while (chosen + 1 < levels.length && pixels <= at(levels, chosen + 1)) chosen++;
  return chosen > 0 && pixels > at(levels, chosen) * (1 - FADE) ? [chosen - 1, chosen] : [chosen];
}

const visible = (lod: Lod) => lod.levels.flatMap(({ object }, i) => (object.visible ? [i] : []));

async function run(model: string) {
  const manager = new THREE.LoadingManager();
  manager.addHandler(/\.glb$/i, gltfLoader(manager));
  const lod = await new LodLoader(manager).loadAsync({
    url: `/models/${model}`,
    levels: [
      { type: "simplified", ratio: 0.2, maxPixels: MAX_PIXELS[1] },
      { type: "impostor", layout: "hemi", maxPixels: MAX_PIXELS[2] },
    ],
  });
  lod.traverse((node) => (node.castShadow = true));
  scene.add(lod);
  const source = at(lod.levels, 0).object;
  const sphere = boundingSphere(source).applyMatrix4(source.matrix);
  const diameter = 2 * sphere.radius;
  const direction = new THREE.Vector3(0.8, 0.25, 0.55).normalize();
  sun.position.copy(sphere.center).addScaledVector(new THREE.Vector3(-0.6, 1, 0.35).normalize(), diameter * 3);
  sun.target.position.copy(sphere.center);
  Object.assign(sun.shadow.camera, {
    left: -diameter * 1.5,
    right: diameter * 1.5,
    top: diameter * 1.5,
    bottom: -diameter * 1.5,
    near: 0.1,
    far: diameter * 6,
  });
  sun.shadow.camera.updateProjectionMatrix();

  /** Place the camera where the model is `pixels` tall and render it (twice: the first frame tells the Lod the target height). */
  const view = (pixels: number) => {
    camera.position.copy(sphere.center).addScaledVector(direction, (diameter * SIZE) / (2 * tan * pixels));
    camera.lookAt(sphere.center);
    frame();
    return frame();
  };

  // Levels per on-screen height, either side of and inside both fades.
  const levels: Array<{ pixels: number; measured: number; visible: number[]; expected: number[] }> = [];
  for (const pixels of [480, 320, 290, 250, 230, 200, 140, 118, 100, 92, 80, 40]) {
    view(pixels);
    const measured = pixelsOf(lod, camera, SIZE);
    levels.push({ pixels, measured, visible: visible(lod), expected: expected(measured * Lod.quality, MAX_PIXELS) });
  }

  // Shadows: the model drawn invisible, so only its shadow shows. Lod.quality makes the
  // impostor the choice at a size where its shadow is big.
  const materials = new Set<THREE.Material>();
  lod.traverse((node) => {
    if (node instanceof THREE.Mesh) for (const material of [node.material].flat()) materials.add(material);
  });
  for (const material of materials) Object.assign(material, { colorWrite: false, depthWrite: false });
  Lod.quality = 0.2;
  const shadowAt = 400;
  const auto = view(shadowAt);
  const chosen = visible(lod);
  lod.forceLevel = at(chosen, 0);
  const forced = view(shadowAt);
  lod.forceLevel = 0;
  const sourceShadow = view(shadowAt);
  lod.forceLevel = null;
  Lod.quality = 1;
  for (const material of materials) Object.assign(material, { colorWrite: true, depthWrite: true });
  const shadows = { chosen, autoVsForced: difference(auto, forced), autoVsSource: difference(auto, sourceShadow) };

  // Pop: consecutive 0.5% steps from 400 px down to 70 px, faded and swapped at once.
  const sweep = (hard: boolean) => {
    const steps: Array<{ pixels: number; change: number }> = [];
    let previous: Uint8Array | null = null;
    for (let pixels = 400; pixels > 70; pixels *= 0.995) {
      lod.forceLevel = hard ? must(expected(pixels, MAX_PIXELS).at(-1), "expected level") : null;
      const image = view(pixels);
      if (previous) steps.push({ pixels, change: difference(previous, image) });
      previous = image;
    }
    lod.forceLevel = null;
    // A pop is a spike against the steps around it: the change per step itself grows
    // with the model's size on screen.
    const spikes = steps.map((step, i) => {
      const around = steps
        .slice(Math.max(0, i - 6), i + 7)
        .filter((_, j) => j !== Math.min(i, 6))
        .map((s) => s.change)
        .sort((a, b) => a - b);
      return { pixels: step.pixels, change: step.change, ratio: step.change / at(around, Math.floor(around.length / 2)) };
    });
    const worst = spikes.reduce((a, b) => (b.ratio > a.ratio ? b : a));
    return { steps: steps.length, worst };
  };
  const faded = sweep(false);
  const hard = sweep(true);

  // First draw of 1000 new Lods at once: each mesh brings its own faded material copies,
  // which three sets up on their first draw (the programs exist already).
  scene.remove(lod);
  const crowd = new THREE.Group();
  for (let i = 0; i < 1000; i++) {
    const copy = lod.clone();
    copy.position.set(((i % 40) - 20) * diameter * 1.5, 0, -Math.floor(i / 40) * diameter * 1.5);
    crowd.add(copy);
  }
  scene.add(crowd);
  camera.position.set(0, diameter * 8, diameter * 12);
  camera.lookAt(0, 0, -diameter * 18);
  const timed = () => {
    const start = performance.now();
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.getContext().finish();
    return performance.now() - start;
  };
  const firstDraw = { firstMs: timed(), nextMs: timed() };
  scene.remove(crowd);

  lod.dispose();
  return { renderer: gpuName(renderer.getContext()), levels, shadows, pop: { faded, hard }, firstDraw };
}

declare global {
  interface Window {
    switching: { run: typeof run };
  }
}
window.switching = { run };

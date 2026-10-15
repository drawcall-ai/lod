import * as THREE from "three";
import { ImpostorMesh, InstancedLod, Lod, bakeImpostor, bakeMesh, simplify } from "@drawcall/lod";
import { boundingSphere } from "../../../packages/lod/src/bounds.js";
import { must } from "./must.js";
import { gltfLoader, gpuName, png } from "./page.js";
import { pixelsOf } from "./pixels.js";

// Standalone page (depth.html): every level under three's depth setups, driven by
// scripts/depth.ts through window.depth.
//
// One renderer per mode: "default", "reversed" (reversedDepthBuffer) and "log"
// (logarithmicDepthBuffer). Each renders into a target with a float depth buffer.
//
// - lit(mode): ground with shadows and a row of Lods forced to source, simplified, baked
//   and impostor (pixel depth on), one Lod in a fade, and InstancedLods of the baked level
//   and of an impostor with pixel depth off; near 0.1, far 1000.
// - masks(mode, near, far): the same objects over flat-coloured ground (sunk into it, so
//   where they meet it shows) and a decal 2 cm above the ground, seen from 20 m up: blue
//   sky, green ground, red decal, anything else is an object.

const SIZE = 512;
export type Mode = "default" | "reversed" | "log";
/** Read-back pixels (bottom row first) as base64, and as a PNG data URL. */
export interface Shot {
  pixels: string;
  image: string;
}

let built: { lods: THREE.Object3D[]; diameter: number } | null = null;

async function build() {
  if (built) return built;
  const source = (await gltfLoader().loadAsync("/models/Rock_Medium_1.glb")).scene;
  const simplified = await simplify(source, { ratio: 0.2 });
  const baked = await bakeMesh(source, { ratio: 0.05 });
  const impostor = await bakeImpostor(source);
  const sphere = boundingSphere(source);
  const diameter = 2 * sphere.radius;
  const box = new THREE.Box3().setFromObject(source);
  // Sunk by a fifth of its height, so every level meets the ground.
  const sink = box.min.y + 0.2 * (box.max.y - box.min.y);

  const levels = (pixelDepth: boolean) => [source.clone(), simplified.clone(), baked.clone(), new ImpostorMesh(impostor, 1, { pixelDepth })];
  const lods: THREE.Object3D[] = [];
  for (let level = 0; level < 4; level++) {
    const lod = new Lod(levels(true));
    lod.forceLevel = level;
    lod.position.set((level - 1.5) * diameter * 1.2, -sink, 0);
    lods.push(lod);
  }
  // In the fade from source to simplified; its thresholds are set once the camera is placed.
  const fading = new Lod(levels(true));
  fading.position.set(0, -sink, diameter * 1.5);
  fading.userData.fading = true;
  lods.push(fading);
  for (const [level, pixelDepth] of [
    [2, true],
    [3, false],
  ] as const) {
    const instanced = new InstancedLod(levels(pixelDepth), 2);
    instanced.forceLevel = level;
    for (let i = 0; i < 2; i++)
      instanced.setMatrixAt(
        i,
        new THREE.Matrix4().makeRotationY(i * 1.3 + level).setPosition((i - 0.5 + (level - 2.5) * 2) * diameter * 1.3, -sink, -diameter * 1.4),
      );
    lods.push(instanced);
  }
  for (const lod of lods)
    lod.traverse((node) => {
      node.castShadow = true;
      node.receiveShadow = true;
    });
  built = { lods, diameter };
  return built;
}

function makeRenderer(mode: Mode, samples: number) {
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    reversedDepthBuffer: mode === "reversed",
    logarithmicDepthBuffer: mode === "log",
  });
  if (mode === "reversed" && !renderer.capabilities.reversedDepthBuffer) throw new Error("depth: no EXT_clip_control here");
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE);
  renderer.shadowMap.enabled = true;
  const target = new THREE.WebGLRenderTarget(SIZE, SIZE, { samples });
  // Reversed depth gains only with a float depth buffer; three's own is 24-bit otherwise.
  target.depthTexture = new THREE.DepthTexture(SIZE, SIZE, THREE.FloatType);
  return { renderer, target };
}

function render(mode: Mode, scene: THREE.Scene, camera: THREE.PerspectiveCamera, samples: number): Uint8Array {
  const { renderer, target } = makeRenderer(mode, samples);
  try {
    renderer.setRenderTarget(target);
    // Twice: the first frame tells the Lods the target height.
    renderer.render(scene, camera);
    renderer.render(scene, camera);
    const pixels = new Uint8Array(SIZE * SIZE * 4);
    renderer.readRenderTargetPixels(target, 0, 0, SIZE, SIZE, pixels);
    return pixels;
  } finally {
    target.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

/** Put the fading Lod in the middle of its fade from source to simplified for `camera`. */
function fade(lods: THREE.Object3D[], camera: THREE.Camera) {
  for (const lod of lods) {
    if (!(lod instanceof Lod) || !lod.userData.fading) continue;
    camera.updateMatrixWorld();
    const height = pixelsOf(lod, camera, SIZE);
    const top = height / 0.875;
    lod.levels.forEach((level, i) => i > 0 && (level.maxPixels = top / 2 ** (i - 1)));
  }
}

async function lit(mode: Mode) {
  const { lods, diameter } = await build();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fa3b8);
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x4a5a3a, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.position.set(-0.6, 1, 0.35).multiplyScalar(diameter * 4);
  Object.assign(sun.shadow.camera, { left: -diameter * 5, right: diameter * 5, top: diameter * 5, bottom: -diameter * 5, near: 0.1, far: diameter * 10 });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun, sun.target);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x7d8a64 }));
  ground.receiveShadow = true;
  scene.add(ground, ...lods);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  camera.position.set(0, diameter * 2.2, diameter * 5.5);
  camera.lookAt(0, 0, 0);
  fade(lods, camera);
  const pixels = render(mode, scene, camera, 4);
  scene.remove(...lods);
  return result(pixels);
}

async function masks(mode: Mode, near: number, far: number) {
  const { lods, diameter } = await build();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0000ff);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x808080, 1));
  const flat = (color: number) => new THREE.MeshBasicMaterial({ color });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000).rotateX(-Math.PI / 2), flat(0x00ff00));
  const decal = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), flat(0xff0000));
  decal.position.set(-60, 0.02, -150);
  // Drawn first, so the ground wins depth ties: the decal shows only where it is in front.
  decal.renderOrder = -1;
  // The objects about 45 m out, 6 m tall, so their contact with the ground reads.
  const group = new THREE.Group();
  group.add(...lods);
  group.scale.setScalar(6 / diameter);
  group.position.set(-10, 0, -45);
  scene.add(ground, decal, group);
  const camera = new THREE.PerspectiveCamera(50, 1, near, far);
  camera.position.set(0, 20, 0);
  camera.lookAt(-15, 0, -60);
  scene.updateMatrixWorld();
  fade(lods, camera);
  // Without multisampling: a logarithmic (or any written) depth is one value per pixel, so
  // edges where surfaces meet resolve differently from per-sample hardware depth.
  const pixels = render(mode, scene, camera, 0);
  group.remove(...lods);
  return result(pixels);
}

function result(pixels: Uint8Array): Shot {
  let binary = "";
  for (const byte of pixels) binary += String.fromCharCode(byte);
  return { pixels: btoa(binary), image: png(pixels, SIZE, SIZE) };
}

const gpu = () => gpuName(must(document.createElement("canvas").getContext("webgl2"), "WebGL2 context"));

declare global {
  interface Window {
    depth: { lit: typeof lit; masks: typeof masks; gpu: typeof gpu };
  }
}
window.depth = { lit, masks, gpu };

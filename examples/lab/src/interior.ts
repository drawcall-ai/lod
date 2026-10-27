import * as THREE from "three/webgpu";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { Lod, bakeMesh } from "@drawcall/lod";
import { readBytes } from "../../../packages/lod/src/renderer.js";
import { house, houseInterior, houseShell } from "./house.js";
import { at } from "./must.js";
import { context2d, glCanvas, gpuRenderer, nextFrame } from "./page.js";
import { pixelsOf } from "./pixels.js";

// Standalone page (interior.html): the house with its rooms behind real glass (source)
// next to its baked level looking into them by interior mapping, through the windows
// from a few distances and angles. Driven by scripts/interior.ts through window.interior.run().
//
// Three lights: "flat", a white ambient light only, under which the source's rooms look
// as the bake renders them (their own colours), so the difference is the mapping's
// alone; "env", the environment only; "lit", sun (casting shadows, so walls keep it out
// of the rooms) and environment.

const TILE = 320;
type Light = "flat" | "env" | "lit";

/** Where the camera stands, relative to the middle front window's centre (0, 2.75, 4), or the +x side window's. */
const VIEWS = [
  { name: "front 4 m", window: "front", offset: [0, 0, 4] },
  { name: "front 4 m, 45°", window: "front", offset: [2.8, 0.3, 2.8] },
  { name: "front 10 m, 30°", window: "front", offset: [-5, 1, 8.7] },
  { name: "front 25 m", window: "front", offset: [3, 4, 25] },
  { name: "side 8 m, 35°", window: "side", offset: [6.5, 0.5, 4.6] },
] as const;
const WINDOWS = { front: new THREE.Vector3(0, 2.75, 4), side: new THREE.Vector3(5, 2.75, 0) };

const log = new THREE.WebGPURenderer({ antialias: true, logarithmicDepthBuffer: true });
log.setSize(TILE, TILE, false);
await log.init();
const renderers = { default: await gpuRenderer(TILE), log };
for (const renderer of Object.values(renderers)) {
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
}
const environment = new THREE.PMREMGenerator(renderers.default).fromScene(new RoomEnvironment(), 0.04).texture;
const environmentLog = new THREE.PMREMGenerator(renderers.log).fromScene(new RoomEnvironment(), 0.04).texture;

function sceneFor(object: THREE.Object3D, light: Light, log: boolean): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x5a6470);
  if (light === "flat") scene.add(new THREE.AmbientLight(0xffffff, Math.PI));
  else {
    scene.environment = log ? environmentLog : environment;
    scene.environmentIntensity = 0.6;
  }
  if (light === "lit") {
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(3, 5, 6).multiplyScalar(3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 60 });
    scene.add(sun);
  }
  return scene.add(object);
}

const target = new THREE.RenderTarget(TILE, TILE, { samples: 4 });

/** One camera per view: a Lod measures each camera at the height it last drew at. */
const cameras = new Map<(typeof VIEWS)[number], THREE.PerspectiveCamera>();

function cameraFor(v: (typeof VIEWS)[number]): THREE.PerspectiveCamera {
  const known = cameras.get(v);
  if (known) return known;
  const at = WINDOWS[v.window];
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
  cameras.set(v, camera);
  camera.position.copy(at).add(new THREE.Vector3(...v.offset));
  camera.lookAt(at);
  camera.updateMatrixWorld();
  return camera;
}

/** `object` seen from view `v` under `light`, as pixels (rows bottom-up). */
async function shoot(object: THREE.Object3D, v: (typeof VIEWS)[number], light: Light, log = false): Promise<Uint8Array> {
  const renderer = log ? renderers.log : renderers.default;
  const camera = cameraFor(v);
  const scene = sceneFor(object, light, log);
  const shot = log ? new THREE.RenderTarget(TILE, TILE, { samples: 4 }) : target;
  await nextFrame(renderer);
  renderer.setRenderTarget(shot);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  const pixels = await readBytes(renderer, shot, 0);
  if (log) shot.dispose();
  scene.remove(object);
  return pixels;
}

/** Mean channel difference over `mask`'s pixels (all if null), and how many. */
function error(a: Uint8Array, b: Uint8Array, mask: Uint8Array | null) {
  let sum = 0;
  let count = 0;
  for (let p = 0; p < a.length / 4; p++) {
    if (mask && !mask[p]) continue;
    for (let c = 0; c < 3; c++) sum += Math.abs(at(a, p * 4 + c) - at(b, p * 4 + c)) / 3;
    count++;
  }
  return { error: count ? Math.round((sum / count) * 100) / 100 : 0, pixels: count };
}

/** Pixels where the rooms show: the source with and without them differ there. */
function windowMask(withRooms: Uint8Array, without: Uint8Array): Uint8Array {
  const mask = new Uint8Array(withRooms.length / 4);
  for (let p = 0; p < mask.length; p++) mask[p] = Math.max(...[0, 1, 2].map((c) => Math.abs(at(withRooms, p * 4 + c) - at(without, p * 4 + c)))) > 6 ? 1 : 0;
  return mask;
}

function image(rows: Uint8Array[][], labels: string[]): string {
  const columns = Math.max(...rows.map((row) => row.length));
  const canvas = document.createElement("canvas");
  canvas.width = columns * TILE;
  canvas.height = rows.length * (TILE + 18);
  const ctx = context2d(canvas);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = "13px system-ui, sans-serif";
  rows.forEach((row, r) => {
    row.forEach((pixels, c) => ctx.drawImage(glCanvas(pixels, TILE, TILE), c * TILE, r * (TILE + 18) + 18));
    ctx.fillStyle = "#eee";
    ctx.fillText(at(labels, r), 6, r * (TILE + 18) + 13);
  });
  return canvas.toDataURL("image/png");
}

const amplified = (a: Uint8Array, b: Uint8Array) => a.map((v, i) => (i % 4 === 3 ? 255 : Math.min(255, Math.abs(v - at(b, i)) * 4)));

/**
 * A Lod of copies of `source` and `baked`, its switch set so that view `v` is in the
 * middle of the fade between them, seen from `v`: the two dither, rooms and all.
 */
async function fading(source: THREE.Object3D, baked: THREE.Object3D, v: (typeof VIEWS)[number]): Promise<Uint8Array> {
  const lod = new Lod([source.clone(), baked.clone()]);
  at(lod.levels, 1).maxPixels = pixelsOf(lod, cameraFor(v), TILE) / 0.95;
  // The first frame teaches the Lod the target's height.
  await shoot(lod, v, "flat");
  const pixels = await shoot(lod, v, "flat");
  const visible = lod.levels.filter((l) => l.object.visible).length;
  if (visible !== 2) throw new Error(`interior: expected both levels in the fade, ${visible} drew`);
  return pixels;
}

async function run() {
  const source = house();
  const rooms = houseInterior();
  source.add(rooms);
  const t0 = performance.now();
  const baked = await bakeMesh(source, { low: houseShell(), interior: rooms });
  const ms = Math.round(performance.now() - t0);
  for (const object of [source, baked])
    object.traverse((node) => {
      node.castShadow = true;
      node.receiveShadow = true;
    });
  const rows: Array<{ light: Light; view: string; error: number; pixels: number; all: number; logVsDefault: number | null; fade: number | null }> = [];
  const images: Record<string, string> = {};
  for (const light of ["flat", "env", "lit"] as const) {
    const sheet: Uint8Array[][] = [];
    for (const v of VIEWS) {
      const real = await shoot(source, v, light);
      rooms.visible = false;
      const empty = await shoot(source, v, light);
      rooms.visible = true;
      const fake = await shoot(baked, v, light);
      const mask = windowMask(real, empty);
      const log = light === "flat" ? error(fake, await shoot(baked, v, light, true), mask).error : null;
      const fade = light === "flat" ? error(real, await fading(source, baked, v), mask).error : null;
      rows.push({ light, view: v.name, ...error(real, fake, mask), all: error(real, fake, null).error, logVsDefault: log, fade });
      sheet.push([real, fake, amplified(real, fake)]);
    }
    images[`interior-${light}`] = image(
      sheet,
      VIEWS.map((v) => `${v.name}: source | baked | difference × 4`),
    );
  }
  return { ms, rows, images };
}

declare global {
  interface Window {
    interior: { run: typeof run };
  }
}
window.interior = { run };

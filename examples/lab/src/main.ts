import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { ImpostorMesh, Lod, bakeImpostor, type BakeImpostorOptions, type Impostor, type ImpostorMeshOptions } from "@drawcall/lod";
import { boundingRadius, boxCentre } from "../../../packages/lod/src/impostor/impostor.js";
import { FADE } from "../../../packages/lod/src/levels.js";
import type { View } from "./bench.js";
import { at } from "./must.js";
import { context2d, glCanvas } from "./page.js";
import { pixelsOf } from "./pixels.js";
import { subject } from "./subjects.js";

// The impostor probe (index.html): a subject's real geometry and its impostor rendered
// from identical cameras and the difference measured. Driven by scripts/probe.ts and
// scripts/fade.ts through window.probe (with ?auto); opened by hand (?subject=<name>) it
// shows the two side by side with orbit controls.

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
// A fixed sun: azimuth 35°, elevation 40°.
sun.position.setFromSphericalCoords(100, THREE.MathUtils.degToRad(90 - 40), THREE.MathUtils.degToRad(35));
scene.add(sun, new THREE.HemisphereLight(0xbfd4ff, 0x4a3d2e, 0.6));

interface Current {
  object: THREE.Object3D;
  impostor: Impostor;
  mesh: ImpostorMesh;
}
let current: Current | null = null;

function shown(): Current {
  if (!current) throw new Error("probe: prepare a subject first");
  return current;
}

/** The loaded subject and its bakes, so sweeps over views and mesh options do not reload or rebake. */
const cache = { name: "", object: new THREE.Object3D(), impostors: new Map<string, Impostor>() };

/** Show subject `name` and its impostor, baked with `bake` and drawn with `options`. */
async function prepare(name: string, bake: BakeImpostorOptions = {}, options: ImpostorMeshOptions = {}) {
  const { load, bake: needs } = subject(name);
  if (current) {
    scene.remove(current.object, current.mesh);
    current.mesh.dispose();
  }
  if (cache.name !== name) {
    cache.name = name;
    cache.object = await load();
    cache.impostors.clear();
    // Impostors are baked in the object's own space: draw both there.
    cache.object.position.set(0, 0, 0);
    cache.object.quaternion.identity();
    cache.object.scale.set(1, 1, 1);
  }
  const { object } = cache;
  const key = JSON.stringify(bake);
  const impostor = cache.impostors.get(key) ?? (await bakeImpostor(object, { renderer, ...needs, ...bake }));
  cache.impostors.set(key, impostor);
  const mesh = new ImpostorMesh(impostor, 1, options);
  current = { object, impostor, mesh };
  scene.add(object, mesh);
}

// ------------------------------------------------------------------ comparison

/** A view of the subject whose bounding sphere is `px` tall. */
type Probe = View & { px: number };

const FOV = 30;
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 1e5);

/** Aim the camera for `view`; the canvas side it needs. */
function place(view: Probe): number {
  const { impostor } = shown();
  const sphere = boundingRadius(impostor.box);
  const centre = new THREE.Vector3(...boxCentre(impostor.box));
  const size = Math.ceil(view.px * 1.25 + 8);
  const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const distance = (2 * sphere * size) / (view.px * 2 * tan);
  camera.position.setFromSphericalCoords(distance, THREE.MathUtils.degToRad(90 - view.elevation), THREE.MathUtils.degToRad(view.azimuth)).add(centre);
  camera.lookAt(centre);
  camera.near = distance / 100;
  camera.far = distance * 4;
  camera.updateProjectionMatrix();
  return size;
}

/** Supersampling of the real object's reference render: an ideal anti-aliased render of it. */
const TRUTH_SCALE = 4;
/** 8-bit sRGB to linear. */
const LINEAR = Array.from({ length: 256 }, (_, v) => (v <= 10 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4)));

/**
 * Effective coverage and colour, independent of how they were produced (blending,
 * alpha-to-coverage, dithering): render over black and over white; coverage is
 * 1 - (white - black) and colour is the black render divided by it. Returned as
 * straight RGBA8. The real object renders at TRUTH_SCALE and is box-filtered down, in
 * linear light, as the GPU's mips and MSAA resolve average.
 */
function renderPixels(size: number, show: "real" | "impostor" | "none"): Uint8Array {
  const k = show === "real" ? TRUTH_SCALE : 1;
  const black = renderRaw(size * k, show, 0x000000);
  const white = renderRaw(size * k, show, 0xffffff);
  const linear = (pixels: Uint8Array, i: number) => at(LINEAR, at(pixels, i));
  const srgb = (c: number) => Math.min(255, 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let sy = 0; sy < k; sy++)
        for (let sx = 0; sx < k; sx++) {
          const i = ((y * k + sy) * size * k + x * k + sx) * 4;
          const cover = 1 - (at(white, i) + at(white, i + 1) + at(white, i + 2) - at(black, i) - at(black, i + 1) - at(black, i + 2)) / (3 * 255);
          // black is colour × cover (premultiplied): sum premultiplied, divide once.
          r += linear(black, i);
          g += linear(black, i + 1);
          b += linear(black, i + 2);
          a += Math.max(0, cover);
        }
      const o = (y * size + x) * 4;
      out[o] = a > 0 ? srgb(r / a) : 0;
      out[o + 1] = a > 0 ? srgb(g / a) : 0;
      out[o + 2] = a > 0 ? srgb(b / a) : 0;
      out[o + 3] = Math.round((a / (k * k)) * 255);
    }
  return out;
}

function renderRaw(size: number, show: "real" | "impostor" | "none", background: number): Uint8Array {
  const c = shown();
  c.object.visible = show === "real";
  c.mesh.visible = show === "impostor";
  const target = new THREE.WebGLRenderTarget(size, size, { samples: 4, colorSpace: THREE.SRGBColorSpace });
  scene.background = new THREE.Color(background);
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  const pixels = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
  renderer.setRenderTarget(null);
  target.dispose();
  scene.background = null;
  c.object.visible = true;
  c.mesh.visible = true;
  return pixels;
}

/** `pixels[i]` as straight colour channel `k` over mid grey. */
const overGrey = (pixels: Uint8Array, i: number, k: number) => {
  const alpha = at(pixels, i + 3) / 255;
  return at(pixels, i + k) * alpha + 128 * (1 - alpha);
};

/** Render real vs impostor and score them: silhouette IoU, colour error over the union, coverage and lighting bias. */
function compare(view: Probe, image = true) {
  const size = place(view);
  const real = renderPixels(size, "real");
  const imp = renderPixels(size, "impostor");
  let [inter, union, colour, both, total, realAlpha, impAlpha, bias] = [0, 0, 0, 0, 0, 0, 0, 0];
  const diff = new Uint8Array(size * size * 4);
  for (let o = 0; o < real.length; o += 4) {
    const ra = at(real, o + 3) / 255;
    const ia = at(imp, o + 3) / 255;
    const rIn = ra > 0.5;
    const iIn = ia > 0.5;
    realAlpha += ra;
    impAlpha += ia;
    if (rIn && iIn) inter++;
    if (rIn || iIn) union++;
    // Over mid grey, so silhouette errors count as colour errors too.
    let e = 0;
    for (let k = 0; k < 3; k++) e += Math.abs(overGrey(real, o, k) - overGrey(imp, o, k));
    e /= 3 * 255;
    if (rIn || iIn) total += e;
    if (rIn && iIn) {
      colour += e;
      both++;
      // Signed luminance difference where both cover: systematic lighting error.
      const luma = (p: Uint8Array) => 0.2126 * at(p, o) + 0.7152 * at(p, o + 1) + 0.0722 * at(p, o + 2);
      bias += (luma(imp) - luma(real)) / 255;
    }
    const heat = Math.min(255, e * 255 * 4);
    diff.set([heat, heat * 0.4, 0, 255], o);
  }
  return {
    iou: union ? inter / union : 1,
    error: union ? total / union : 0,
    colourError: both ? colour / both : 0,
    coverage: realAlpha ? impAlpha / realAlpha : 1,
    bias: both ? bias / both : 0,
    image: image ? composite(size, [real, imp, diff]) : "",
  };
}

/**
 * Flicker: slide the camera sideways in quarter-pixel steps and measure the mean
 * per-pixel change between consecutive frames, for the impostor relative to the
 * ground truth. 1 means the impostor is as stable as the real object.
 */
function stability(view: Probe, steps = 8) {
  const size = place(view);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const pixel = (2 * camera.position.distanceTo(new THREE.Vector3(...boxCentre(shown().impostor.box))) * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / size;
  const start = camera.position.clone();
  const change = { real: 0, impostor: 0 };
  for (const show of ["real", "impostor"] as const) {
    let previous: Uint8Array | null = null;
    for (let i = 0; i < steps; i++) {
      camera.position.copy(start).addScaledVector(right, i * 0.25 * pixel);
      camera.updateMatrixWorld();
      const frame = renderPixels(size, show);
      if (previous) {
        let sum = 0;
        for (let p = 0; p < frame.length; p += 4) for (let k = 0; k < 3; k++) sum += Math.abs(overGrey(frame, p, k) - overGrey(previous, p, k));
        change[show] += sum / (size * size * 3 * 255);
      }
      previous = frame;
    }
  }
  camera.position.copy(start);
  return { real: change.real, impostor: change.impostor, ratio: change.impostor / Math.max(change.real, 1e-9) };
}

/**
 * Fade: a Lod of the real object and the impostor seen `amount` of the way through its
 * fade (0 = all impostor, 1 = all real), against the ground truth. Coverage must stay
 * ~1: no holes, no double-drawn pixels.
 */
function fade(view: Probe, amount = 0.5) {
  const c = shown();
  const size = place(view);
  const truth = renderPixels(size, "real");
  const impostor = new ImpostorMesh(c.impostor);
  const lod = new Lod([c.object.clone(true), impostor]);
  scene.add(lod);
  // The first frame tells the Lod the viewport height; then put it `amount` of the way
  // through the fade.
  renderRaw(size, "none", 0x000000);
  at(lod.levels, 1).maxPixels = pixelsOf(lod, camera, size) / (1 - FADE * (1 - amount));
  const both = renderPixels(size, "none");
  const drawn = lod.levels.flatMap(({ object }, i) => (object.visible ? [i] : []));
  scene.remove(lod);
  // The levels share the real object's resources; only the impostor mesh is the Lod's own.
  impostor.dispose();
  let [truthAlpha, bothAlpha, error, n] = [0, 0, 0, 0];
  for (let i = 0; i < truth.length; i += 4) {
    const ta = at(truth, i + 3) / 255;
    const ba = at(both, i + 3) / 255;
    truthAlpha += ta;
    bothAlpha += ba;
    if (ta <= 0.5 && ba <= 0.5) continue;
    let e = 0;
    for (let k = 0; k < 3; k++) e += Math.abs(overGrey(truth, i, k) - overGrey(both, i, k));
    error += e / (3 * 255);
    n++;
  }
  return { drawn, coverage: bothAlpha / Math.max(truthAlpha, 1e-6), error: n ? error / n : 0, image: composite(size, [truth, both]) };
}

/** `images` (GL rows, bottom-up) side by side over grey, as a PNG data URL. */
function composite(size: number, images: Uint8Array[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = size * images.length;
  canvas.height = size;
  const context = context2d(canvas);
  context.fillStyle = "#808080";
  context.fillRect(0, 0, canvas.width, canvas.height);
  images.forEach((pixels, i) => context.drawImage(glCanvas(pixels, size, size), i * size, 0));
  return canvas.toDataURL("image/png");
}

const probe = { prepare, compare, stability, fade };

declare global {
  interface Window {
    probe: typeof probe;
  }
}
window.probe = probe;

// ------------------------------------------------------------------ interactive view

const params = new URLSearchParams(location.search);
if (!params.has("auto")) {
  await prepare(params.get("subject") ?? "tree");
  const { object, mesh, impostor } = shown();
  const radius = boundingRadius(impostor.box);
  object.position.x = -radius * 1.1;
  mesh.position.x = radius * 1.1;
  scene.background = new THREE.Color(0x87a0b8);
  const view = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 1e4);
  view.position.set(0, radius, radius * 6);
  const controls = new OrbitControls(view, renderer.domElement);
  controls.target.set(0, boxCentre(impostor.box)[1], 0);
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight);
    view.aspect = innerWidth / innerHeight;
    view.updateProjectionMatrix();
  };
  addEventListener("resize", resize);
  resize();
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, view);
  });
}

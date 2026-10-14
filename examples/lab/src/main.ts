import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import {
  ImpostorMesh,
  bakeImpostor,
  fadeObject,
  encodeImpostor,
  boundingRadius,
  boxCentre,
  writeImpostorGlts,
  type BakeOptions,
  type Impostor,
  type ImpostorMeshOptions,
} from "@drawcall/impostor";
import { frameBasis, frameDirection } from "@drawcall/impostor";
import { subjects } from "./subjects.js";
import { GLTSLoader } from "@drawcall/glts";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { encodeToKTX2 } from "ktx2-encoder";
import { RING_ABLATION, crossQuads, sprite } from "./kinds.js";
import { LOD_ERROR, bakedLod, lodReady, simplifyLod } from "./lod.js";

// The lab renders a subject's real geometry and its impostor from identical cameras
// and measures the difference. `window.lab` drives it from scripts/eval.ts; opening
// the page by hand shows the two side by side with orbit controls.

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x4a3d2e, 0.6));

function setSun(azimuth: number, elevation: number): void {
  const a = THREE.MathUtils.degToRad(azimuth);
  const e = THREE.MathUtils.degToRad(elevation);
  sun.position.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)).multiplyScalar(100);
}
setSun(35, 40);

interface Current {
  name: string;
  object: THREE.Object3D;
  impostor: Impostor;
  mesh: ImpostorMesh;
}
let current: Current | null = null;

/**
 * Per-subject cache: the loaded object, its bakes and its built proxies, so sweeps over
 * views and techniques do not reload or rebake. Cleared when the subject changes.
 */
const cache = { name: "", object: null as THREE.Object3D | null, impostors: new Map<string, Impostor>(), proxies: new Map<string, THREE.Object3D>() };
async function cached<T>(map: Map<string, T>, key: string, make: () => T | Promise<T>): Promise<T> {
  if (!map.has(key)) map.set(key, await make());
  return map.get(key)!;
}

async function prepare(name: string, bake: BakeOptions = {}, options: ImpostorMeshOptions = {}) {
  const subject = subjects.find((s) => s.name === name);
  if (!subject) throw new Error(`unknown subject ${name}`);
  if (current) {
    scene.remove(current.object, current.mesh);
    current.mesh.dispose();
  }
  if (cache.name !== name) {
    cache.name = name;
    cache.object = await subject.load();
    cache.impostors.clear();
    cache.proxies.clear();
  }
  const object = cache.object!;
  const start = performance.now();
  const impostor = await cached(cache.impostors, JSON.stringify(bake), () => bakeImpostor(object, { renderer, ...subject.bake, ...bake }));
  const bakeMs = performance.now() - start;
  const mesh = new ImpostorMesh(impostor, 1, options);
  // Investigation: { ablate: [[search, replace], ...] } rewrites the impostor's fragment shader.
  const kind = (options as { kind?: string }).kind;
  const ablate = (options as { ablate?: Array<[string, string]> }).ablate ?? [];
  const ablateVertex = kind?.startsWith("ring") ? [RING_ABLATION] : [];
  if (ablate.length || ablateVertex.length) {
    const compile = mesh.material.onBeforeCompile;
    const key = mesh.material.customProgramCacheKey;
    mesh.material.onBeforeCompile = (shader, r) => {
      compile.call(mesh.material, shader, r);
      for (const [a, b] of ablate) {
        if (!shader.fragmentShader.includes(a)) throw new Error(`ablate: "${a}" not found`);
        shader.fragmentShader = shader.fragmentShader.replace(a, b);
      }
      for (const [a, b] of ablateVertex) {
        if (!shader.vertexShader.includes(a)) throw new Error(`ablate: "${a}" not found`);
        shader.vertexShader = shader.vertexShader.replace(a, b);
      }
    };
    mesh.material.customProgramCacheKey = () => key.call(mesh.material) + JSON.stringify([ablate, ablateVertex]);
  }
  // Other proxy kinds, built from this bake's horizon views (see kinds.ts).
  if (kind === "real" || kind === "cross2" || kind === "cross3" || kind === "sprite" || kind === "lod-simple" || kind === "lod-baked") {
    // Mesh LODs at 5% of the triangles: a typical last mesh level before culling.
    await lodReady;
    const lodError = (options as { lodError?: number }).lodError ?? 0;
    const texture = (options as { texture?: number }).texture ?? 1024;
    const proxy =
      kind === "real" ? await cached(cache.proxies, "real", () => object.clone(true))
      : kind === "sprite" ? sprite(impostor)
      : kind === "lod-simple" || kind === "lod-baked" ? await buildLod(kind, lodError, texture)
      : crossQuads(impostor, kind === "cross2" ? 2 : 3);
    mesh.dispose();
    const stand = proxy as unknown as ImpostorMesh;
    (stand as unknown as { dispose: () => void }).dispose = () => {};
    current = { name, object, impostor, mesh: stand };
    scene.add(object, proxy);
    return { name, kind };
  }
  // Probe mode: plain alpha blending shows the coverage the impostor ideally has.
  if ((options as { blend?: boolean }).blend) {
    mesh.material.alphaTest = 0;
    mesh.material.alphaToCoverage = false;
    mesh.material.transparent = true;
    mesh.material.depthWrite = false;
  }
  current = { name, object, impostor, mesh };
  scene.add(object, mesh);
  const encoded = encodeImpostor(impostor);
  return {
    name,
    bakeMs: Math.round(bakeMs),
    frames: impostor.frames,
    size: impostor.size,
    layout: impostor.layout,
    maps: impostor.maps,
    halfSize: impostor.halfSize,
    sphere: boundingRadius(impostor.box),
    encodedKB: Math.round(encoded.length / 1024),
  };
}

/** A mesh LOD of the current subject (cached): simple decimation or a baked proxy. */
function buildLod(kind: "lod-simple" | "lod-baked", lodError: number, texture: number): Promise<THREE.Object3D> {
  return cached(cache.proxies, `${kind}|${lodError}|${kind === "lod-baked" ? texture : ""}`, async () => {
    LOD_ERROR.value = lodError;
    return kind === "lod-simple" ? simplifyLod(cache.object!, 0.05) : bakedLod(cache.object!, 0.05, texture);
  });
}

function remesh(options: ImpostorMeshOptions): void {
  if (!current) throw new Error("prepare first");
  scene.remove(current.mesh);
  current.mesh.dispose();
  current.mesh = new ImpostorMesh(current.impostor, 1, options);
  scene.add(current.mesh);
}

// ------------------------------------------------------------------ comparison

export interface View {
  /** projected bounding-sphere diameter in pixels */
  px: number;
  /** degrees above the horizon */
  elevation: number;
  azimuth: number;
  sun?: [number, number];
  /** instance transform applied to both the real object and the impostor */
  rotation?: [number, number, number];
  scale?: [number, number, number];
  /** vertical field of view in degrees; default 30 */
  fov?: number;
  /** camera distance from the centre in bounding-sphere radii; default: framed so the sphere spans `px` */
  distance?: number;
  /** instead: this many radii outside the object's bounding box along the view direction */
  outside?: number;
  /** shadow maps on: both cast and receive, the impostor receives only when `receive` */
  shadows?: boolean;
  receive?: boolean;
}

const FOV = 30;
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 1e5);

function place(view: View): number {
  const c = current!;
  const sphere = boundingRadius(c.impostor.box);
  const centre = new THREE.Vector3(...boxCentre(c.impostor.box));
  const size = Math.ceil(view.px * 1.25 + 8);
  const fov = view.fov ?? FOV;
  const tan = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  camera.fov = fov;
  const e = THREE.MathUtils.degToRad(view.elevation);
  const a = THREE.MathUtils.degToRad(view.azimuth);
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(view.rotation ?? [0, 0, 0]).map(THREE.MathUtils.degToRad) as [number, number, number]));
  const transform = new THREE.Matrix4().compose(new THREE.Vector3(), rotation, new THREE.Vector3(...(view.scale ?? [1, 1, 1])));
  const towards = new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a));
  let distance = view.distance !== undefined ? view.distance * sphere : (2 * sphere * size) / (view.px * 2 * tan);
  if (view.outside !== undefined) {
    // Where the view ray leaves the (object-space) bounding box, plus a margin.
    const u = towards.clone().applyQuaternion(rotation.clone().invert());
    const b = c.impostor.box;
    const exit = Math.min(...[0, 1, 2].map((i) => (b[i + 3]! - b[i]!) / 2 / Math.max(Math.abs(u.getComponent(i)), 1e-6)));
    distance = exit + view.outside * sphere;
  }
  for (const o of [c.object, c.mesh]) {
    o.matrixAutoUpdate = false;
    o.matrix.copy(transform);
    o.updateMatrixWorld(true);
  }
  const target = centre.applyMatrix4(transform);
  camera.position.copy(towards).multiplyScalar(distance).add(target);
  camera.lookAt(target);
  camera.aspect = 1;
  camera.near = distance / 100;
  camera.far = distance * 4;
  camera.updateProjectionMatrix();
  setSun(...(view.sun ?? [35, 40]));
  renderer.shadowMap.enabled = !!view.shadows;
  sun.castShadow = !!view.shadows;
  if (view.shadows) {
    sun.target.position.copy(target);
    sun.position.add(target);
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -sphere, right: sphere, top: sphere, bottom: -sphere, near: 1, far: 200 + sphere * 2 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.needsUpdate = true;
    sun.shadow.bias = (view as { bias?: number }).bias ?? 0;
    sun.shadow.normalBias = ((view as { normalBias?: number }).normalBias ?? 0) * sphere;
    c.object.traverse((n) => ((n as THREE.Mesh).castShadow = (n as THREE.Mesh).receiveShadow = true));
    c.mesh.castShadow = true;
    c.mesh.receiveShadow = !!view.receive;
  }
  return size;
}

/**
 * Effective coverage and colour, independent of how they were produced (blending,
 * alpha-to-coverage, dithering): render over black and over white; coverage is
 * 1 - (white - black) and colour is the black render divided by it. Returned as
 * straight RGBA8. The real object is the ground truth, so it renders at 4x and is
 * box-filtered down: what an ideal anti-aliased render of it looks like.
 */
// Averages must happen in linear light, as the GPU's mips and MSAA resolve do.
const LINEAR = Array.from({ length: 256 }, (_, v) => srgbToLinear(v / 255));
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c: number): number {
  return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

/** Supersampling of the real object's reference render; 1 = what an app shows natively. */
let truthScale = 4;

function renderPixels(size: number, show: "real" | "impostor"): Uint8Array {
  const k = show === "real" ? truthScale : 1;
  const black = renderRaw(size * k, show, 0x000000);
  const white = renderRaw(size * k, show, 0xffffff);
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < k; sy++)
        for (let sx = 0; sx < k; sx++) {
          const i = ((y * k + sy) * size * k + x * k + sx) * 4;
          const cover = 1 - (white[i]! + white[i + 1]! + white[i + 2]! - black[i]! - black[i + 1]! - black[i + 2]!) / (3 * 255);
          // black[i] is colour * cover (premultiplied); sum premultiplied, divide once.
          r += LINEAR[black[i]!]!; g += LINEAR[black[i + 1]!]!; b += LINEAR[black[i + 2]!]!; a += Math.max(0, cover);
        }
      const o = (y * size + x) * 4;
      out[o] = a > 0 ? Math.min(255, linearToSrgb(r / a)) : 0;
      out[o + 1] = a > 0 ? Math.min(255, linearToSrgb(g / a)) : 0;
      out[o + 2] = a > 0 ? Math.min(255, linearToSrgb(b / a)) : 0;
      out[o + 3] = Math.round((a / (k * k)) * 255);
    }
  return out;
}

function renderRaw(size: number, show: "real" | "impostor", background: number): Uint8Array {
  const c = current!;
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

/** Render real vs impostor and score them: silhouette IoU and colour error over the union. */
function compare(view: View, image = true) {
  const size = place(view);
  const real = renderPixels(size, "real");
  const imp = renderPixels(size, "impostor");
  let inter = 0;
  let union = 0;
  let colour = 0;
  let both = 0;
  let total = 0;
  let realAlpha = 0;
  let impAlpha = 0;
  let bias = 0;
  const diff = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    const ra = real[o + 3]! / 255;
    const ia = imp[o + 3]! / 255;
    const rIn = ra > 0.5;
    const iIn = ia > 0.5;
    realAlpha += ra;
    impAlpha += ia;
    if (rIn && iIn) inter++;
    if (rIn || iIn) union++;
    // Composite both over mid grey so silhouette errors count as colour errors too.
    let e = 0;
    for (let k = 0; k < 3; k++) {
      const r = real[o + k]! * ra + 128 * (1 - ra);
      const m = imp[o + k]! * ia + 128 * (1 - ia);
      e += Math.abs(r - m);
    }
    e /= 3 * 255;
    if (rIn || iIn) total += e;
    if (rIn && iIn) {
      colour += e;
      both++;
      // Signed luminance difference where both cover: systematic lighting error.
      bias += (0.2126 * (imp[o]! - real[o]!) + 0.7152 * (imp[o + 1]! - real[o + 1]!) + 0.0722 * (imp[o + 2]! - real[o + 2]!)) / 255;
    }
    const heat = Math.min(255, e * 255 * 4);
    diff[o] = heat;
    diff[o + 1] = heat * 0.4;
    diff[o + 2] = 0;
    diff[o + 3] = 255;
  }
  const luma = (p: Uint8Array | Uint8ClampedArray, o: number) => 0.2126 * p[o]! + 0.7152 * p[o + 1]! + 0.0722 * p[o + 2]!;
  const realLuma: number[] = [];
  const impLuma: number[] = [];
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    if (real[o + 3]! > 128) realLuma.push(luma(real, o));
    if (imp[o + 3]! > 128) impLuma.push(luma(imp, o));
  }
  realLuma.sort((a, b) => a - b);
  impLuma.sort((a, b) => a - b);
  const threshold = 0.6 * (realLuma[realLuma.length >> 1] ?? 0);
  const darkShare = (l: number[]) => (l.length ? l.filter((v) => v < threshold).length / l.length : 0);
  const result = {
    realDark: darkShare(realLuma),
    impDark: darkShare(impLuma),
    realMedian: realLuma[realLuma.length >> 1] ?? 0,
    impMedian: impLuma[impLuma.length >> 1] ?? 0,
    iou: union ? inter / union : 1,
    error: union ? total / union : 0,
    colourError: both ? colour / both : 0,
    coverage: realAlpha ? impAlpha / realAlpha : 1,
    bias: both ? bias / both : 0,
    image: image ? composite(size, [real, imp, diff]) : "",
  };
  return result;
}

/**
 * Flicker: slide the camera sideways in quarter-pixel steps and measure the mean
 * per-pixel change between consecutive frames, for the impostor relative to the
 * ground truth. 1 means the impostor is as stable as the real object.
 */
function stability(view: View, steps = 8) {
  const size = place(view);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const pixel = (2 * camera.position.distanceTo(new THREE.Vector3(...boxCentre(current!.impostor.box))) * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / size;
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
        for (let p = 0; p < frame.length; p += 4) {
          // premultiplied over grey, like compare()
          for (let k = 0; k < 3; k++) {
            const a = (frame[p + k]! * frame[p + 3]!) / 255 + 128 * (1 - frame[p + 3]! / 255);
            const b = (previous[p + k]! * previous[p + 3]!) / 255 + 128 * (1 - previous[p + 3]! / 255);
            sum += Math.abs(a - b);
          }
        }
        change[show] += sum / (size * size * 3 * 255);
      }
      previous = frame;
    }
  }
  camera.position.copy(start);
  return { real: change.real, impostor: change.impostor, ratio: change.impostor / Math.max(change.real, 1e-9) };
}

/**
 * Hand-off: the real object (faded) and the impostor (faded) drawn together, mid-band
 * at `amount` (0 = all impostor, 1 = all real), against the ground truth. Coverage must
 * stay ~1: no holes, no double-drawn pixels.
 */
function handoff(view: View, amount = 0.5) {
  const c = current!;
  const size = place(view);
  const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const subtense = (view.px * 2 * tan) / size;
  const band: [number, number] = [subtense / (1 + amount * 0.4), subtense / (1 - (1 - amount) * 0.4)];
  const truth = renderPixels(size, "real");
  const faded = c.object.clone(true);
  fadeObject(faded, c.impostor, band);
  faded.matrix.copy(c.object.matrix);
  faded.matrixAutoUpdate = false;
  faded.updateMatrixWorld(true);
  scene.add(faded);
  c.mesh.fadeBand.set(...band);
  // Draw both: "impostor" mode hides the original real object but shows the mesh.
  const both = renderPixels(size, "impostor");
  c.mesh.fadeBand.set(0, 0);
  scene.remove(faded);
  let truthAlpha = 0;
  let bothAlpha = 0;
  let error = 0;
  let n = 0;
  for (let i = 0; i < truth.length; i += 4) {
    const ta = truth[i + 3]! / 255;
    const ba = both[i + 3]! / 255;
    truthAlpha += ta;
    bothAlpha += ba;
    if (ta > 0.5 || ba > 0.5) {
      let e = 0;
      for (let k = 0; k < 3; k++) e += Math.abs(truth[i + k]! * ta + 128 * (1 - ta) - (both[i + k]! * ba + 128 * (1 - ba)));
      error += e / (3 * 255);
      n++;
    }
  }
  return { band, coverage: bothAlpha / Math.max(truthAlpha, 1e-6), error: n ? error / n : 0, image: composite(size, [truth, both]) };
}

/**
 * Shadows: the real object and the impostor side by side on a ground plane, lit by a
 * shadow-casting directional light (or a point light), seen from a fixed camera.
 */
function shadows(light: "directional" | "point" = "directional", size = 384, receive = false, fromSun = false) {
  const c = current!;
  const sphere = boundingRadius(c.impostor.box);
  const centre = new THREE.Vector3(...boxCentre(c.impostor.box));
  const floorY = c.impostor.box[1];
  const offset = sphere * 1.3;
  const group = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(sphere * 12, sphere * 12), new THREE.MeshStandardMaterial({ color: 0x9a9a90 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = floorY;
  ground.receiveShadow = true;
  group.add(ground);
  const real = c.object.clone(true);
  real.matrixAutoUpdate = true;
  real.matrix.identity();
  real.position.set(-offset, 0, 0);
  real.traverse((n) => ((n as THREE.Mesh).castShadow = true));
  const imp = new ImpostorMesh(c.impostor, 1);
  imp.position.set(offset, 0, 0);
  imp.castShadow = true;
  imp.receiveShadow = receive;
  real.traverse((n) => ((n as THREE.Mesh).receiveShadow = receive));
  group.add(real, imp);
  let caster: THREE.Light;
  if (light === "directional") {
    const sunLight = new THREE.DirectionalLight(0xffffff, 3);
    sunLight.position.set(sphere * 2, sphere * 4, sphere * 1.5).add(centre);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    const s = sphere * 4;
    Object.assign(sunLight.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 0.1, far: sphere * 12 });
    sunLight.shadow.camera.updateProjectionMatrix();
    caster = sunLight;
  } else {
    const point = new THREE.PointLight(0xffffff, sphere * sphere * 60, 0, 2);
    point.position.set(0, centre.y + sphere * 1.6, sphere * 0.6);
    point.castShadow = true;
    point.shadow.mapSize.set(1024, 1024);
    caster = point;
  }
  group.add(caster);
  scene.add(group);
  const visible = [c.object.visible, c.mesh.visible, sun.intensity];
  c.object.visible = false;
  c.mesh.visible = false;
  sun.intensity = 0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const view = new THREE.PerspectiveCamera(40, 1.6, 0.01, sphere * 100);
  view.position.set(0, centre.y + sphere * 1.2, sphere * 5.5);
  view.lookAt(0, floorY + sphere * 0.6, 0);
  if (fromSun && light === "directional") {
    // Look along the light: everything the camera sees of each tree faces the sun.
    view.position.copy(caster.position).sub(centre).normalize().multiplyScalar(sphere * 6).add(centre);
    view.lookAt(centre);
  }
  const width = Math.round(size * 1.6);
  const target = new THREE.WebGLRenderTarget(width, size, { samples: 4, colorSpace: THREE.SRGBColorSpace });
  scene.background = new THREE.Color(0x87a0b8);
  renderer.setRenderTarget(target);
  renderer.render(scene, view);
  const pixels = new Uint8Array(width * size * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, size, pixels);
  renderer.setRenderTarget(null);
  target.dispose();
  scene.background = null;
  scene.remove(group);
  imp.dispose();
  renderer.shadowMap.enabled = false;
  [c.object.visible, c.mesh.visible, sun.intensity] = visible as [boolean, boolean, number];
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = size;
  const flipped = new Uint8ClampedArray(width * size * 4);
  for (let y = 0; y < size; y++) flipped.set(pixels.subarray((size - 1 - y) * width * 4, (size - y) * width * 4), y * width * 4);
  canvas.getContext("2d")!.putImageData(new ImageData(flipped, width, size), 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Debug: swap the real object's and the impostor's output for a shading input
 * ("normal": view-space normal, "albedo": diffuse colour), then compare.
 */
function debugCompare(view: View, what: "normal" | "albedo" | "direct" | "indirect" | "specular") {
  const c = current!;
  const outs = {
    normal: "vec4(normalize(normal) * 0.5 + 0.5, diffuseColor.a)",
    albedo: "vec4(diffuseColor.rgb, diffuseColor.a)",
    direct: "vec4(reflectedLight.directDiffuse, diffuseColor.a)",
    indirect: "vec4(reflectedLight.indirectDiffuse, diffuseColor.a)",
    specular: "vec4(reflectedLight.directSpecular + reflectedLight.indirectSpecular, diffuseColor.a)",
  };
  const out = outs[what];
  const patched: Array<[THREE.Material, THREE.Material["onBeforeCompile"], () => string]> = [];
  const patch = (m: THREE.Material) => {
    const before = m.onBeforeCompile;
    const key = m.customProgramCacheKey;
    patched.push([m, before, key]);
    m.onBeforeCompile = (shader, r) => {
      before.call(m, shader, r);
      shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", `gl_FragColor = ${out};`);
    };
    m.customProgramCacheKey = () => key.call(m) + "|debug-" + what;
    m.needsUpdate = true;
  };
  c.object.traverse((n) => {
    const mesh = n as THREE.Mesh;
    if (mesh.isMesh) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(patch);
  });
  patch(c.mesh.material);
  const toneMapping = renderer.toneMapping;
  const result = compare(view, true);
  for (const [m, before, key] of patched) {
    m.onBeforeCompile = before;
    m.customProgramCacheKey = key;
    m.needsUpdate = true;
  }
  renderer.toneMapping = toneMapping;
  return result;
}

function composite(size: number, images: Array<Uint8Array | Uint8ClampedArray>): string {
  const canvas = document.createElement("canvas");
  canvas.width = size * images.length;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  images.forEach((pixels, i) => {
    // GL rows are bottom-up.
    const flipped = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) flipped.set(pixels.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
    const tile = document.createElement("canvas");
    tile.width = tile.height = size;
    tile.getContext("2d")!.putImageData(new ImageData(flipped, size, size), 0, 0);
    ctx.drawImage(tile, i * size, 0);
  });
  return canvas.toDataURL("image/png");
}

/** The atlas layers as images, for inspection. */
function atlas(): Record<string, string> {
  const c = current!;
  const out: Record<string, string> = {};
  c.impostor.maps.forEach((map, i) => {
    const s = c.impostor.size;
    const layer = c.impostor.layers[i]!;
    const rgba = new Uint8ClampedArray(layer.length);
    for (let p = 0; p < layer.length; p += 4) {
      rgba[p] = layer[p]!;
      rgba[p + 1] = layer[p + 1]!;
      rgba[p + 2] = layer[p + 2]!;
      rgba[p + 3] = 255;
    }
    out[map] = composite(s, [rgba]);
    if (map === "base" || map === "normalDepth") {
      const alpha = new Uint8ClampedArray(layer.length);
      for (let p = 0; p < layer.length; p += 4) alpha[p] = alpha[p + 1] = alpha[p + 2] = layer[p + 3]!, (alpha[p + 3] = 255);
      out[`${map}.a`] = composite(s, [alpha]);
    }
  });
  return out;
}

// ------------------------------------------------------------------ performance

/**
 * Average GPU+CPU frame time for `count` instances scattered over a field, drawn as
 * real geometry or as impostors, at a typical ground-level camera.
 */
async function perf(count: number, mode: "real" | "impostor" | "cross2" | "cross3" | "sprite" | "proxy", frames = 60) {
  const c = current!;
  c.object.visible = false;
  c.mesh.visible = false;
  const sphere = boundingRadius(c.impostor.box);
  const spacing = sphere * 2.2;
  const side = Math.ceil(Math.sqrt(count));
  const random = mulberry(7);
  const matrices: THREE.Matrix4[] = [];
  for (let i = 0; i < count; i++) {
    const x = ((i % side) - side / 2) * spacing + (random() - 0.5) * spacing * 0.6;
    const z = (Math.floor(i / side) - side / 2) * spacing + (random() - 0.5) * spacing * 0.6;
    const s = 0.8 + random() * 0.4;
    matrices.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * 6.28), new THREE.Vector3(s, s, s)));
  }
  const group = new THREE.Group();
  let triangles = 0;
  if (mode === "cross2" || mode === "cross3" || mode === "sprite") {
    // Plain instanced planes; the sprite's cost is approximated by one static plane.
    const proxy = mode === "sprite" ? sprite(c.impostor) : crossQuads(c.impostor, mode === "cross2" ? 2 : 3);
    const planes: THREE.Mesh[] = [];
    proxy.traverse((n) => (n as THREE.Mesh).isMesh && planes.push(n as THREE.Mesh));
    for (const plane of planes) {
      const inst = new THREE.InstancedMesh(plane.geometry, plane.material, count);
      matrices.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.computeBoundingSphere();
      group.add(inst);
    }
    triangles = 2 * planes.length * count;
  } else if (mode === "impostor") {
    const mesh = new ImpostorMesh(c.impostor, count);
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.computeBoundingSphere();
    group.add(mesh);
    triangles = 2 * count;
  } else {
    // "real" draws the original object, "proxy" whatever prepare() built (mesh LODs).
    const drawn = mode === "proxy" ? (c.mesh as unknown as THREE.Object3D) : c.object;
    drawn.updateMatrixWorld(true);
    drawn.traverse((node) => {
      const m = node as THREE.Mesh;
      if (!m.isMesh) return;
      const local = new THREE.Matrix4().copy(drawn.matrixWorld).invert().multiply(m.matrixWorld);
      const inst = new THREE.InstancedMesh(m.geometry, m.material, count);
      matrices.forEach((mm, i) => inst.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(mm, local)));
      inst.computeBoundingSphere();
      group.add(inst);
      const index = m.geometry.index;
      triangles += ((index ? index.count : m.geometry.getAttribute("position").count) / 3) * count;
    });
  }
  scene.add(group);
  const width = 1280;
  const height = 720;
  renderer.setSize(width, height, false);
  const view = new THREE.PerspectiveCamera(60, width / height, 0.1, side * spacing * 2);
  view.position.set(0, sphere * 1.2, side * spacing * 0.55);
  view.lookAt(0, sphere * 0.5, 0);
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  if (!timer) throw new Error("GPU timer queries unavailable");
  for (let i = 0; i < 5; i++) renderer.render(scene, view);
  // GPU time per frame from timer queries; gl.finish does not block under ANGLE/Metal.
  const pending: WebGLQuery[] = [];
  const times: number[] = [];
  for (let i = 0; i < frames; i++) {
    const query = gl.createQuery()!;
    gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    renderer.render(scene, view);
    gl.endQuery(timer.TIME_ELAPSED_EXT);
    pending.push(query);
    await new Promise(requestAnimationFrame);
  }
  while (pending.length) {
    const query = pending[0]!;
    if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
      await new Promise(requestAnimationFrame);
      continue;
    }
    if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) times.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
    gl.deleteQuery(query);
    pending.shift();
  }
  scene.remove(group);
  group.traverse((n) => (n as THREE.InstancedMesh).isInstancedMesh && n !== group && (n as THREE.InstancedMesh).dispose());
  c.object.visible = true;
  c.mesh.visible = true;
  times.sort((a, b) => a - b);
  return { mode, count, triangles, medianMs: times[Math.floor(times.length / 2)]!, p90Ms: times[Math.floor(times.length * 0.9)]! };
}

/** One level of a chain: instances at least `minPx` tall on screen use `kind`. */
interface ChainLevel {
  /** "none": not drawn, to time the other levels of a split alone */
  kind: "real" | "lod-simple" | "lod-baked" | "octa" | "none";
  minPx: number;
  /** mesh LODs: built for 1 px of error at this on-screen size */
  buildPx?: number;
  /** baked LODs: texture size */
  texture?: number;
}

/**
 * GPU time of a whole strategy: `count` instances on a field, each drawn by the first
 * level whose `minPx` its projected size reaches. `elevation` > 0 views the field from
 * above at that angle; `tumble` gives every instance a random 3D rotation.
 */
async function perfChain(count: number, levels: ChainLevel[], elevation = 0, tumble = false, frames = 40) {
  const c = current!;
  const sphere = boundingRadius(c.impostor.box);
  const spacing = sphere * 2.2;
  const side = Math.ceil(Math.sqrt(count));
  const random = mulberry(7);
  const width = 1280;
  const height = 720;
  renderer.setSize(width, height, false);
  const view = new THREE.PerspectiveCamera(60, width / height, 0.1, side * spacing * 3);
  // Standing in the middle of the field, so instances range from right next to the camera
  // to the horizon: at eye height, or (elevation > 0) above the canopy looking down.
  if (elevation > 0) {
    const e = THREE.MathUtils.degToRad(elevation);
    // Just above the tops (bounding sphere ~2 radii high), so the nearest are close-ups.
    const y = sphere * 3;
    view.position.set(spacing / 2, y, spacing / 2);
    view.lookAt(spacing / 2, y - Math.sin(e), spacing / 2 - Math.cos(e));
  } else {
    // Between grid points, so no instance stands on the camera.
    view.position.set(spacing / 2, sphere * 0.3, spacing / 2);
    view.lookAt(spacing / 2, sphere * 0.3, spacing / 2 - 1);
  }
  view.updateMatrixWorld();
  const pxPerUnit = height / (2 * Math.tan(THREE.MathUtils.degToRad(view.fov / 2)));
  const centre = new THREE.Vector3(...boxCentre(c.impostor.box));
  const buckets: THREE.Matrix4[][] = levels.map(() => []);
  for (let i = 0; i < count; i++) {
    const x = ((i % side) - side / 2) * spacing + (random() - 0.5) * spacing * 0.6;
    const z = (Math.floor(i / side) - side / 2) * spacing + (random() - 0.5) * spacing * 0.6;
    const s = 0.8 + random() * 0.4;
    const q = tumble
      ? new THREE.Quaternion().setFromEuler(new THREE.Euler(random() * 6.28, random() * 6.28, random() * 6.28))
      : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * 6.28);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s, s));
    const px = (2 * sphere * s * pxPerUnit) / Math.max(centre.clone().applyMatrix4(m).distanceTo(view.position), 1e-6);
    buckets[Math.max(0, levels.findIndex((l) => px >= l.minPx))]!.push(m);
  }
  const group = new THREE.Group();
  let triangles = 0;
  for (const [i, level] of levels.entries()) {
    const matrices = buckets[i]!;
    if (!matrices.length || level.kind === "none") continue;
    if (level.kind === "octa") {
      const mesh = new ImpostorMesh(c.impostor, matrices.length);
      matrices.forEach((m, j) => mesh.setMatrixAt(j, m));
      mesh.computeBoundingSphere();
      // Levels are ordered near to far: draw near ones first so they occlude the rest early.
      mesh.renderOrder = i;
      group.add(mesh);
      triangles += 2 * matrices.length;
      continue;
    }
    const source = level.kind === "real" ? c.object : await buildLod(level.kind, level.buildPx ? 1 / level.buildPx : 0, level.texture ?? 1024);
    source.updateMatrixWorld(true);
    source.traverse((node) => {
      const m = node as THREE.Mesh;
      if (!m.isMesh) return;
      const local = new THREE.Matrix4().copy(source.matrixWorld).invert().multiply(m.matrixWorld);
      const inst = new THREE.InstancedMesh(m.geometry, m.material, matrices.length);
      matrices.forEach((mm, j) => inst.setMatrixAt(j, new THREE.Matrix4().multiplyMatrices(mm, local)));
      inst.computeBoundingSphere();
      inst.renderOrder = i;
      group.add(inst);
      triangles += ((m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute("position").count) / 3) * matrices.length;
    });
  }
  scene.add(group);
  c.object.visible = false;
  c.mesh.visible = false;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  if (!timer) throw new Error("GPU timer queries unavailable");
  for (let i = 0; i < 2; i++) renderer.render(scene, view);
  const pending: WebGLQuery[] = [];
  const times: number[] = [];
  // Heavy scenes (a second per frame) stop early: 5 frames are plenty for a median there.
  const began = performance.now();
  for (let i = 0; i < frames && !(i >= 5 && performance.now() - began > 2000); i++) {
    const query = gl.createQuery()!;
    gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    renderer.render(scene, view);
    gl.endQuery(timer.TIME_ELAPSED_EXT);
    pending.push(query);
    await new Promise(requestAnimationFrame);
  }
  while (pending.length) {
    const query = pending[0]!;
    if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
      await new Promise(requestAnimationFrame);
      continue;
    }
    if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) times.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
    gl.deleteQuery(query);
    pending.shift();
  }
  scene.remove(group);
  group.traverse((n) => (n as THREE.InstancedMesh).isInstancedMesh && (n as THREE.InstancedMesh).dispose());
  c.object.visible = true;
  c.mesh.visible = true;
  times.sort((a, b) => a - b);
  return { count, triangles, perLevel: buckets.map((b) => b.length), medianMs: times[Math.floor(times.length / 2)]! };
}

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function info() {
  const gl = renderer.getContext();
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  return { renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
}

declare global {
  interface Window {
    lab: unknown;
  }
}
/** Geometry facts that matter for baking: duplicated (coplanar back-to-back) faces and their normals. */
function inspect() {
  const c = current!;
  const out: Array<Record<string, unknown>> = [];
  c.object.traverse((n) => {
    const mesh = n as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const pos = g.getAttribute("position");
    const nor = g.getAttribute("normal");
    const index = g.index;
    const tri = (index ? index.count : pos.count) / 3;
    const at = (i: number) => (index ? index.getX(i) : i);
    const key = (v: number) => `${pos.getX(v).toFixed(4)},${pos.getY(v).toFixed(4)},${pos.getZ(v).toFixed(4)}`;
    const faces = new Map<string, number>();
    let duplicates = 0;
    let sameWinding = 0;
    let normalsAgree = 0;
    let normalVsFace = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), cc = new THREE.Vector3(), fn = new THREE.Vector3(), vn = new THREE.Vector3();
    for (let t = 0; t < tri; t++) {
      const v = [at(t * 3), at(t * 3 + 1), at(t * 3 + 2)];
      a.fromBufferAttribute(pos, v[0]!); b.fromBufferAttribute(pos, v[1]!); cc.fromBufferAttribute(pos, v[2]!);
      fn.subVectors(cc, b).cross(a.clone().sub(b)).normalize();
      vn.fromBufferAttribute(nor, v[0]!).add(new THREE.Vector3().fromBufferAttribute(nor, v[1]!)).add(new THREE.Vector3().fromBufferAttribute(nor, v[2]!)).normalize();
      normalVsFace += fn.dot(vn);
      const sorted = v.map(key).sort().join("|");
      const other = faces.get(sorted);
      if (other === undefined) { faces.set(sorted, t); continue; }
      duplicates++;
      const ov = [at(other * 3), at(other * 3 + 1), at(other * 3 + 2)].map(key);
      const mine = v.map(key);
      // same cyclic order = same winding
      const shift = ov.indexOf(mine[0]!);
      if (ov[(shift + 1) % 3] === mine[1]) sameWinding++;
      const on = new THREE.Vector3().fromBufferAttribute(nor, at(other * 3));
      if (on.dot(new THREE.Vector3().fromBufferAttribute(nor, v[0]!)) > 0.5) normalsAgree++;
    }
    const material = Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material;
    out.push({ name: mesh.name, material: material.name, side: material.side, tri, duplicates, sameWinding, normalsAgree, meanNormalDotFace: +(normalVsFace / tri).toFixed(3) });
  });
  return out;
}

const NORMAL_OUT = "gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0);";

/**
 * Runtime check: the impostor and the real object, both rendered with frame (col, row)'s
 * orthographic camera at `size`, outputting linear view-space normals (and N.L for the
 * sun); per-pixel comparison where both cover.
 */
function runtimeCheck(col: number, row: number, size = 512) {
  const c = current!;
  const imp = c.impostor;
  const n = frameDirection(imp.layout, imp.frames, col, row);
  const { tangent: t, bitangent: b } = frameBasis(n);
  const centre = new THREE.Vector3(...boxCentre(imp.box));
  const sphere = boundingRadius(imp.box);
  const r = imp.halfSize;
  const cam = new THREE.OrthographicCamera(-r, r, r, -r, 0, 4 * sphere);
  cam.matrixAutoUpdate = false;
  const d = 2 * sphere;
  cam.matrix.set(t[0], b[0], n[0], centre.x + n[0] * d, t[1], b[1], n[1], centre.y + n[1] * d, t[2], b[2], n[2], centre.z + n[2] * d, 0, 0, 0, 1);
  cam.updateMatrixWorld(true);
  const sunDir = sun.position.clone().normalize().transformDirection(cam.matrixWorldInverse);
  const shoot = (show: "real" | "impostor") => {
    const patched: Array<[THREE.Material, THREE.Material["onBeforeCompile"], () => string]> = [];
    const patch = (m: THREE.Material) => {
      const before = m.onBeforeCompile, key = m.customProgramCacheKey;
      patched.push([m, before, key]);
      m.onBeforeCompile = (sh, rr) => { before.call(m, sh, rr); sh.fragmentShader = sh.fragmentShader.replace("#include <opaque_fragment>", "gl_FragColor = vec4(normal, 1.0);"); };
      m.customProgramCacheKey = () => key.call(m) + "|runtimecheck";
      m.needsUpdate = true;
    };
    if (show === "real") c.object.traverse((o) => { const mesh = o as THREE.Mesh; if (mesh.isMesh) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(patch); });
    else patch(c.mesh.material);
    const keep = [c.object.matrix.clone(), c.mesh.matrix.clone()] as const;
    for (const o of [c.object, c.mesh]) { o.matrixAutoUpdate = false; o.matrix.identity(); o.updateMatrixWorld(true); }
    c.object.visible = show === "real";
    c.mesh.visible = show === "impostor";
    const target = new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType });
    renderer.setRenderTarget(target);
    renderer.setClearColor(0, 0);
    renderer.clear();
    renderer.render(scene, cam);
    const px = new Float32Array(size * size * 4);
    renderer.readRenderTargetPixels(target, 0, 0, size, size, px);
    renderer.setRenderTarget(null);
    target.dispose();
    c.object.matrix.copy(keep[0]); c.mesh.matrix.copy(keep[1]);
    c.object.updateMatrixWorld(true); c.mesh.updateMatrixWorld(true);
    c.object.visible = c.mesh.visible = true;
    for (const [m, before, key] of patched) { m.onBeforeCompile = before; m.customProgramCacheKey = key; m.needsUpdate = true; }
    return px;
  };
  const real = shoot("real");
  const im = shoot("impostor");
  // Registration: the shift (impostor relative to real) that best aligns the normals.
  const shifts: Array<[number, number, number]> = [];
  for (let dy = -6; dy <= 6; dy += 1)
    for (let dx = -6; dx <= 6; dx += 1) {
      let a = 0, k = 0;
      for (let y = 8; y < size - 8; y += 2)
        for (let x = 8; x < size - 8; x += 2) {
          const o = (y * size + x) * 4, q = ((y + dy) * size + x + dx) * 4;
          if (real[o + 3]! < 0.5 || im[q + 3]! < 0.5) continue;
          const rl = Math.hypot(real[o]!, real[o + 1]!, real[o + 2]!) || 1, il = Math.hypot(im[q]!, im[q + 1]!, im[q + 2]!) || 1;
          a += (real[o]! * im[q]! + real[o + 1]! * im[q + 1]! + real[o + 2]! * im[q + 2]!) / (rl * il);
          k++;
        }
      shifts.push([dx, dy, a / k]);
    }
  shifts.sort((p, q) => q[2] - p[2]);
  (window as unknown as { lastShift: unknown }).lastShift = shifts.slice(0, 3);
  let count = 0, angle = 0, nlReal = 0, nlImp = 0, lenImp = 0, flipped = 0;
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    if (real[o + 3]! < 0.5 || im[o + 3]! < 0.5) continue;
    const rv = new THREE.Vector3(real[o]!, real[o + 1]!, real[o + 2]!);
    const iv = new THREE.Vector3(im[o]!, im[o + 1]!, im[o + 2]!);
    lenImp += iv.length();
    const rn = rv.clone().normalize(), inn = iv.clone().normalize();
    angle += Math.acos(Math.max(-1, Math.min(1, rn.dot(inn)))) * 180 / Math.PI;
    flipped += rn.dot(inn) < -0.5 ? 1 : 0;
    nlReal += Math.max(0, rv.dot(sunDir));
    nlImp += Math.max(0, iv.dot(sunDir));
    count++;
  }
  return { bestShift: shifts[0]![0] * 100 + shifts[0]![1], bestCos: shifts[0]![2], zeroCos: shifts.find((v) => v[0] === 0 && v[1] === 0)![2], count, meanAngle: angle / count, flipped: flipped / count, meanNdotLReal: nlReal / count, meanNdotLImp: nlImp / count, meanLenImp: lenImp / count };
}

/**
 * Bake check: render the real object with the exact orthographic camera of atlas frame
 * (col, row), output view-space normals, and compare texel by texel with that frame of
 * the baked normal layer (converted to the same view space).
 */
function frameCheck(col: number, row: number, k = 4, sun = false) {
  const c = current!;
  const imp = c.impostor;
  const cell = imp.size / imp.frames;
  const n = frameDirection(imp.layout, imp.frames, col, row);
  const { tangent: t, bitangent: b } = frameBasis(n);
  const centre = new THREE.Vector3(...boxCentre(imp.box));
  const sphere = boundingRadius(imp.box);
  const r = imp.halfSize;
  const cam = new THREE.OrthographicCamera(-r, r, r, -r, 0, 4 * sphere);
  cam.matrixAutoUpdate = false;
  const d = 2 * sphere;
  cam.matrix.set(t[0], b[0], n[0], centre.x + n[0] * d, t[1], b[1], n[1], centre.y + n[1] * d, t[2], b[2], n[2], centre.z + n[2] * d, 0, 0, 0, 1);
  cam.updateMatrixWorld(true);
  // real render of view-space normals, alpha = coverage
  const patched: Array<[THREE.Material, THREE.Material["onBeforeCompile"], () => string]> = [];
  c.object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const before = m.onBeforeCompile, key = m.customProgramCacheKey;
      patched.push([m, before, key]);
      m.onBeforeCompile = (sh, rr) => { before.call(m, sh, rr); sh.fragmentShader = sh.fragmentShader.replace("#include <opaque_fragment>", NORMAL_OUT); };
      m.customProgramCacheKey = () => key.call(m) + "|framecheck";
      m.needsUpdate = true;
    }
  });
  const size = cell * k;
  const target = new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType });
  c.mesh.visible = false;
  const matrix = c.object.matrix.clone();
  c.object.matrix.identity();
  c.object.updateMatrixWorld(true);
  renderer.setRenderTarget(target);
  renderer.setClearColor(0, 0);
  renderer.clear();
  renderer.render(scene, cam);
  const px = new Float32Array(size * size * 4);
  renderer.readRenderTargetPixels(target, 0, 0, size, size, px);
  renderer.setRenderTarget(null);
  target.dispose();
  c.object.matrix.copy(matrix);
  c.object.updateMatrixWorld(true);
  c.mesh.visible = true;
  for (const [m, before, key] of patched) { m.onBeforeCompile = before; m.customProgramCacheKey = key; m.needsUpdate = true; }
  const layer = imp.layers[imp.maps.indexOf("normalDepth")]!;
  const base = imp.layers[0]!;
  let count = 0, angle = 0, zReal = 0, zBake = 0, awayReal = 0, awayBake = 0, flipped = 0;
  for (let y = 0; y < cell; y++)
    for (let x = 0; x < cell; x++) {
      const ai = ((row * cell + y) * imp.size + col * cell + x) * 4;
      if (base[ai + 3]! < 200) continue;
      // majority-renormalised real normal over the k x k block, like the bake's downsample
      let rx = 0, ry = 0, rz = 0, cov = 0;
      for (let sy = 0; sy < k; sy++) for (let sx = 0; sx < k; sx++) {
        const i = ((y * k + sy) * size + x * k + sx) * 4;
        if (px[i + 3]! < 0.5) continue;
        rx += px[i]! * 2 - 1; ry += px[i + 1]! * 2 - 1; rz += px[i + 2]! * 2 - 1; cov++;
      }
      if (cov < k * k * 0.75) continue;
      const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
      // baked object-space normal into this camera's view space: (dot t, dot b, dot n)
      const ox = layer[ai]! / 127.5 - 1, oy = layer[ai + 1]! / 127.5 - 1, oz = layer[ai + 2]! / 127.5 - 1;
      let bx = ox * t[0] + oy * t[1] + oz * t[2], by = ox * b[0] + oy * b[1] + oz * b[2], bz = ox * n[0] + oy * n[1] + oz * n[2];
      const bl = Math.hypot(bx, by, bz) || 1; bx /= bl; by /= bl; bz /= bl;
      const dot = rx * bx + ry * by + rz * bz;
      angle += Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
      zReal += rz; zBake += bz; awayReal += rz < 0.2 ? 1 : 0; awayBake += bz < 0.2 ? 1 : 0; flipped += dot < -0.5 ? 1 : 0;
      count++;
    }
  return { count, meanAngle: angle / count, zReal: zReal / count, zBake: zBake / count, awayReal: awayReal / count, awayBake: awayBake / count, flipped: flipped / count };
}

/**
 * Extra GPU memory the current proxy needs beyond the real asset, in bytes: impostor
 * atlas pixels actually kept by the kind (with mips), or LOD geometry plus any baked
 * textures (the simple LOD reuses the real object's textures).
 */
function memory(kind: string) {
  const c = current!;
  const mips = 4 / 3;
  const cellBytes = (c.impostor.size / c.impostor.frames) ** 2 * 4 * c.impostor.layers.length * mips;
  const frames: Record<string, number> = { ring16: 16, ring8: 8, cross3: 6, cross2: 4, sprite: 1 };
  if (kind in frames) return { bytes: frames[kind]! * cellBytes, triangles: kind.startsWith("cross") ? 4 * Number(kind.at(-1)) : 2 };
  if (!kind.startsWith("lod") && kind !== "real") return { bytes: c.impostor.frames ** 2 * cellBytes, triangles: 2 };
  let bytes = 0;
  let triangles = 0;
  const textures = new Set<THREE.Texture>();
  (c.mesh as unknown as THREE.Object3D).traverse((n) => {
    const m = n as THREE.Mesh;
    if (!m.isMesh) return;
    for (const a of Object.values(m.geometry.attributes)) bytes += (a as THREE.BufferAttribute).array.byteLength;
    if (m.geometry.index) bytes += m.geometry.index.array.byteLength;
    triangles += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute("position").count) / 3;
    if (kind === "lod-baked" || kind === "real")
      for (const mat of Array.isArray(m.material) ? m.material : [m.material])
        for (const t of Object.values(mat as unknown as Record<string, unknown>))
          if ((t as THREE.Texture)?.isTexture) textures.add(t as THREE.Texture);
  });
  let textureBytes = 0;
  for (const t of textures) {
    const img = t.image as { width: number; height: number };
    textureBytes += img.width * img.height * 4 * mips;
  }
  return { bytes: bytes + textureBytes, textureBytes, triangles };
}

// ------------------------------------------------------------------ block compression (experiment)

let ktx2: KTX2Loader | null = null;
type Codec = "uastc" | "uastc-rdo" | "etc1s";

/**
 * Re-encodes the current bake's layers with Basis Universal (one KTX2 per map, mips
 * generated by the encoder), transcodes them for this GPU with KTX2Loader and swaps
 * them into a fresh ImpostorMesh. Returns file bytes, GPU bytes and the chosen formats.
 */
async function compress(codec: Codec) {
  const c = current!;
  const imp = c.impostor;
  ktx2 ??= new KTX2Loader().setTranscoderPath("/node_modules/three/examples/jsm/libs/basis/").detectSupport(renderer);
  const textures: Record<string, THREE.Texture> = {};
  let fileBytes = 0;
  let gpuBytes = 0;
  let encodeMs = 0;
  const formats: string[] = [];
  for (const [i, map] of imp.maps.entries()) {
    const srgb = map === "base" || map === "emissive";
    const start = performance.now();
    const file = await encodeToKTX2(imp.layers[i]!, {
      isUASTC: codec !== "etc1s",
      isPerceptual: srgb,
      isSetKTX2SRGBTransferFunc: srgb,
      generateMipmap: true,
      needSupercompression: codec !== "etc1s",
      enableRDO: codec === "uastc-rdo",
      rdoQualityLevel: 1,
      uastcLDRQualityLevel: 2,
      qualityLevel: 255,
      imageDecoder: async (data: Uint8Array) => ({ width: imp.size, height: imp.size, data }),
    });
    encodeMs += performance.now() - start;
    fileBytes += file.byteLength;
    const texture = await new Promise<THREE.CompressedTexture>((done, fail) => ktx2!.parse(file.slice().buffer, done as (t: THREE.Texture) => void, fail));
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    textures[map] = texture;
    formats.push(String(texture.format));
    for (const mip of texture.mipmaps as Array<{ data: ArrayBufferView }>) gpuBytes += mip.data.byteLength;
  }
  // A fresh mesh whose shader uniforms point at the compressed textures.
  scene.remove(c.mesh);
  c.mesh.dispose();
  const mesh = new ImpostorMesh(imp, 1, {});
  const compile = mesh.material.onBeforeCompile;
  mesh.material.onBeforeCompile = (shader, r) => {
    compile.call(mesh.material, shader, r);
    for (const [map, texture] of Object.entries(textures)) {
      const name = `impostor${map[0]!.toUpperCase()}${map.slice(1)}`;
      if (!shader.uniforms[name]) throw new Error(`no uniform ${name}`);
      shader.uniforms[name] = { value: texture };
    }
  };
  c.mesh = mesh;
  scene.add(mesh);
  const raw = imp.layers.length * imp.size * imp.size * 4;
  return { codec, fileBytes, zlibBytes: encodeImpostor(imp).byteLength, gpuBytes, rgba8GpuBytes: Math.round(raw * 4 / 3), encodeMs: Math.round(encodeMs), formats };
}

/** The current bake as a `.glts` file (what an app would ship). */
function exportGlts(): string {
  return writeImpostorGlts(current!.impostor);
}

/** FNV-1a over an impostor's layers: identifies a bake across page loads. */
function bakeHash(impostor = current!.impostor): string {
  let h = 0x811c9dc5;
  for (const layer of impostor.layers) for (let i = 0; i < layer.length; i++) h = Math.imul(h ^ layer[i]!, 0x01000193);
  return (h >>> 0).toString(16);
}

/** Loads a written `.glts` through GLTSLoader; returns the hash of the bake it carries. */
async function checkGlts(url: string) {
  const loader = new GLTSLoader(new THREE.LoadingManager(), { cdnURL: new URL("/esm/", location.origin).href });
  const root = await loader.loadAsync(url).catch((e: Error) => {
    let chain = "";
    for (let c: unknown = e; c; c = (c as Error).cause) chain += `${(c as Error).message}\n`;
    throw new Error(chain);
  });
  let mesh: ImpostorMesh | undefined;
  root.traverse((n) => ((n as ImpostorMesh).isImpostorMesh ? (mesh ??= n as ImpostorMesh) : undefined));
  const hash = mesh ? bakeHash(mesh.impostor) : null;
  root.dispose();
  loader.dispose();
  return hash;
}

window.lab = { compress, perfChain, exportGlts, checkGlts, bakeHash, memory, setTruthScale: (k: number) => void (truthScale = k), runtimeCheck, frameCheck, inspect, subjects: subjects.map((s) => ({ name: s.name, why: s.why })), prepare, remesh, compare, stability, handoff, shadows, debugCompare, atlas, perf, info };

// ------------------------------------------------------------------ interactive view

const params = new URLSearchParams(location.search);
if (!params.has("auto")) {
  const name = params.get("subject") ?? "tree";
  await prepare(name);
  const c = current!;
  const offset = boundingRadius(c.impostor.box) * 1.1;
  c.object.position.x = -offset;
  c.mesh.position.x = offset;
  scene.background = new THREE.Color(0x87a0b8);
  const view = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 1e4);
  view.position.set(0, boundingRadius(c.impostor.box), boundingRadius(c.impostor.box) * 6);
  const controls = new OrbitControls(view, renderer.domElement);
  controls.target.set(0, boxCentre(c.impostor.box)[1], 0);
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

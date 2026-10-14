import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { bakeImpostor, type BakeOptions } from "@drawcall/impostor";
import { Forest, type Mode, type SpeciesSource } from "./forest.js";
import { HORIZON, createGround, createSky, createSun, height } from "./world.js";

const params = new URLSearchParams(location.search);
const auto = params.has("auto");
if (auto) document.body.classList.add("auto");

// ------------------------------------------------------------------ renderer, scene

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: auto });
renderer.setPixelRatio(auto ? 1 : Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = HORIZON.clone();
scene.fog = new THREE.FogExp2(HORIZON.getHex(), 0.0017);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.25;
pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xc4dcff, 0x4c5a32, 0.9));
const sun = createSun(2048);
scene.add(sun.light, sun.light.target);
const sky = createSky();
scene.add(sky, createGround());

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.2, 2000);

// ------------------------------------------------------------------ load and bake

const progress = document.getElementById("progress")!;
const gltf = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath("/draco/"));

interface Spec {
  name: string;
  file: string;
  weight: number;
  bake?: BakeOptions;
}
const SPECS: Spec[] = [
  { name: "pine", file: "Pine_2.glb", weight: 0.36 },
  { name: "tree", file: "CommonTree_3.glb", weight: 0.34 },
  { name: "bush", file: "Bush_Common_Flowers.glb", weight: 0.22 },
  { name: "dead", file: "DeadTree_2.glb", weight: 0.08 },
];

/** Subtense (bounding diameter / distance) band: trees (~11 m across) swap at ~60–90 m. */
const FADE: [number, number] = [0.12, 0.18];
const TOTAL = 40_000;

const bakeTimes: Record<string, number> = {};
async function load(): Promise<Forest> {
  const roots = await Promise.all(SPECS.map(async (s) => (await gltf.loadAsync(`/models/${s.file}`)).scene));
  const sources: SpeciesSource[] = [];
  for (let i = 0; i < SPECS.length; i++) {
    const spec = SPECS[i]!;
    progress.textContent = `Baking ${spec.name} impostor (${i + 1}/${SPECS.length})…`;
    await new Promise(requestAnimationFrame);
    const start = performance.now();
    const impostor = await bakeImpostor(roots[i]!, { renderer, ...spec.bake });
    bakeTimes[spec.name] = Math.round(performance.now() - start);
    sources.push({ name: spec.name, root: roots[i]!, impostor, weight: spec.weight });
  }
  progress.textContent = "Scattering…";
  await new Promise(requestAnimationFrame);
  const forest = new Forest(sources, TOTAL, FADE);
  scene.add(forest.group);
  return forest;
}

// ------------------------------------------------------------------ fly camera

const look = { yaw: -0.45, pitch: -0.04 };
const keys = new Set<string>();
addEventListener("keydown", (e) => keys.add(e.code));
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => keys.clear());
renderer.domElement.addEventListener("pointerdown", (e) => renderer.domElement.setPointerCapture(e.pointerId));
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!e.buttons) return;
  look.yaw -= e.movementX * 0.003;
  look.pitch = THREE.MathUtils.clamp(look.pitch - e.movementY * 0.003, -1.5, 1.5);
});

camera.position.set(20, height(20, -10) + 2, -10);

function steer(dt: number): void {
  camera.quaternion.setFromEuler(new THREE.Euler(look.pitch, look.yaw, 0, "YXZ"));
  const move = new THREE.Vector3(
    (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0),
    (keys.has("KeyE") ? 1 : 0) - (keys.has("KeyQ") ? 1 : 0),
    (keys.has("KeyS") ? 1 : 0) - (keys.has("KeyW") ? 1 : 0),
  );
  if (move.lengthSq() === 0) return;
  const speed = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 60 : 12;
  const vertical = move.y;
  move.y = 0;
  move.applyQuaternion(camera.quaternion).setY(0);
  if (move.lengthSq() > 0) move.normalize();
  camera.position.addScaledVector(move, speed * dt);
  camera.position.y += vertical * speed * dt;
  camera.position.y = Math.max(camera.position.y, height(camera.position.x, camera.position.z) + 0.6);
}

function setCamera(position: [number, number, number], target: [number, number, number], fov = 60): void {
  camera.fov = fov;
  camera.updateProjectionMatrix();
  camera.position.set(...position);
  camera.lookAt(...target);
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
  look.yaw = e.y;
  look.pitch = e.x;
}

// ------------------------------------------------------------------ frame

function resize(width = innerWidth, height = innerHeight): void {
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
addEventListener("resize", () => resize());
resize();

let forest: Forest | null = null;
const frameStats = { calls: 0, triangles: 0 };

function render(): void {
  camera.updateMatrixWorld();
  forest?.update(camera.position);
  sky.position.copy(camera.position);
  // 150 m of shadow around the focus at ground level, up to 300 m from altitude where
  // the view takes in more ground. Impostor shadow casting is fragment-bound, so this
  // is a cost/coverage trade.
  const altitude = camera.position.y - height(camera.position.x, camera.position.z);
  sun.follow(shadowFocus(), THREE.MathUtils.clamp(150 + (altitude - 10) * 2, 150, 300));
  renderer.render(scene, camera);
  opaqueAlpha();
  frameStats.calls = renderer.info.render.calls;
  frameStats.triangles = renderer.info.render.triangles;
}

/**
 * three always creates its context with alpha and composites as premultiplied. Alpha-
 * to-coverage materials (every impostor) leave fractional alpha in the drawing buffer,
 * so the page would show through and brighten them (white speckle in fog). Force the
 * canvas opaque after each frame.
 */
function opaqueAlpha(): void {
  const gl = renderer.getContext();
  gl.colorMask(false, false, false, true);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.colorMask(true, true, true, true);
  renderer.resetState(); // three's cached GL state no longer matches
}

/**
 * Where the shadow map is centred: where the view meets the ground when that is
 * within reach (looking down from above), else 45 m ahead of the camera.
 */
function shadowFocus(): THREE.Vector3 {
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const p = new THREE.Vector3();
  for (let t = 10; t <= 600; t += 10) {
    p.copy(camera.position).addScaledVector(dir, t);
    if (p.y < height(p.x, p.z)) return p;
  }
  const ahead = dir.setY(0);
  if (ahead.lengthSq() > 1e-6) ahead.normalize();
  return p.copy(camera.position).addScaledVector(ahead, 45);
}

const hud = {
  root: document.getElementById("hud")!,
  fps: document.getElementById("fps")!,
  calls: document.getElementById("calls")!,
  tris: document.getElementById("tris")!,
  near: document.getElementById("near")!,
  total: document.getElementById("total")!,
};
let frames = 0;
let since = performance.now();
let previous = performance.now();

function loop(now: number): void {
  const dt = Math.min((now - previous) / 1000, 0.1);
  previous = now;
  steer(dt);
  render();
  frames++;
  if (now - since > 500 && forest) {
    hud.fps.textContent = ((frames * 1000) / (now - since)).toFixed(0);
    hud.calls.textContent = String(frameStats.calls);
    hud.tris.textContent = frameStats.triangles.toLocaleString();
    hud.near.textContent = forest.nearCount.toLocaleString();
    hud.total.textContent = forest.total.toLocaleString();
    frames = 0;
    since = now;
  }
}

// ------------------------------------------------------------------ automation

/** GPU time of the current view: median and p90 over `count` frames, via timer queries. */
async function gpuTime(count = 60) {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  if (!timer) throw new Error("GPU timer queries unavailable");
  for (let i = 0; i < 5; i++) render();
  const pending: WebGLQuery[] = [];
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const query = gl.createQuery()!;
    gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    render();
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
  times.sort((a, b) => a - b);
  return { medianMs: times[Math.floor(times.length / 2)] ?? NaN, p90Ms: times[Math.floor(times.length * 0.9)] ?? NaN };
}

function stats() {
  const f = forest!;
  const gl = renderer.getContext();
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    gpu: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
    calls: frameStats.calls,
    triangles: frameStats.triangles,
    near: f.nearCount,
    total: f.total,
    perSpecies: Object.fromEntries(f.species.map((s) => [s.name, { count: s.count, near: s.near }])),
    bakeMs: bakeTimes,
    camera: camera.position.toArray().map((v) => +v.toFixed(2)),
  };
}

const ready = load().then((f) => {
  forest = f;
  progress.remove();
  hud.root.hidden = false;
  const radios = document.querySelectorAll<HTMLInputElement>('input[name="mode"]');
  radios.forEach((r) => r.addEventListener("change", () => r.checked && f.setMode(r.value as Mode)));
  const band = document.getElementById("band") as HTMLInputElement;
  band.addEventListener("change", () => f.setTint(band.checked));
  if (!auto) renderer.setAnimationLoop(loop);
});

declare global {
  interface Window {
    forest: unknown;
  }
}
if (auto)
  window.forest = {
    ready,
    setCamera,
    setMode: (mode: Mode) => forest!.setMode(mode),
    setTint: (on: boolean) => forest!.setTint(on),
    resize,
    screenshot(): string {
      render();
      return renderer.domElement.toDataURL("image/png");
    },
    stats,
    gpuTime,
    height,
    nearest,
    /** live objects, for poking at from scripts */
    debug: { THREE, scene, renderer, camera, sun: sun.light, get forest() { return forest; }, render },
  };

/** The instance of `name` nearest to (x, z): position, scale. Automation only, so a scan is fine. */
function nearest(name: string, x: number, z: number) {
  const sp = forest!.species.find((s) => s.name === name);
  if (!sp) throw new Error(`no species ${name}`);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < sp.count; i++) {
    const d = (sp.matrices[i * 16 + 12]! - x) ** 2 + (sp.matrices[i * 16 + 14]! - z) ** 2;
    if (d < bestD) [best, bestD] = [i, d];
  }
  const m = new THREE.Matrix4().fromArray(sp.matrices, best * 16);
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  m.decompose(p, q, sc);
  return { position: p.toArray(), scale: sc.x, diameter: sp.diameters[best]! };
}

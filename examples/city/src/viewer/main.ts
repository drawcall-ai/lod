// Content viewer: pick a generator or fetched model, orbit around it under the HDRI sky.
// ?item=<name> selects an item, ?view=close|medium a framing, ?seed=<n> the interior plan's
// house, ?shot hides the panel. window.viewer exposes the same controls to scripts/shots.ts.
import * as THREE from "three/webgpu";
import { mrt, normalView, output, packNormalToRGB, pass, pow, sample, unpackRGBToNormal, vec3, vec4 } from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { triangles } from "../content/geometry.ts";
import { loadManifest } from "../content/materials.ts";
import { buildItem, type Item, itemNames } from "./items.ts";
import { Stage } from "./stage.ts";

type View = "close" | "medium";

// Texture loads go through the default manager; `idle` resolves once nothing is loading.
let idle: Promise<void> = Promise.resolve();
THREE.DefaultLoadingManager.onStart = () => {
  idle = new Promise((resolve) => (THREE.DefaultLoadingManager.onLoad = resolve));
};

const params = new URLSearchParams(location.search);
if (params.has("shot")) document.body.classList.add("shot");

const renderer = new THREE.WebGPURenderer({ powerPreference: "high-performance" });
await renderer.init();
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
// Khronos PBR Neutral keeps hues and saturation closest to a photograph up close; AgX
// washes out and ACES shifts greens.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.8;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.prepend(renderer.domElement);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 2000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

await loadManifest();
const stage = new Stage();
await stage.loadSky(renderer);

// ambient occlusion (GTAO) supplies the contact darkening that image-based light lacks
const scene = pass(stage.scene, camera, { samples: 4 });
scene.setMRT(mrt({ output, normal: packNormalToRGB(normalView) }));
const normals = scene.getTextureNode("normal");
const occlusion = ao(
  scene.getTextureNode("depth"),
  sample((uv) => unpackRGBToNormal(normals.sample(uv))),
  camera,
);
const intensity = 2.5;
const post = new THREE.RenderPipeline(renderer, scene.getTextureNode("output").mul(vec4(vec3(pow(occlusion.getTextureNode().r, intensity)), 1)));

function element<T extends Element>(selector: string, type: new () => T): T {
  const e = document.querySelector(selector);
  if (!(e instanceof type)) throw new Error(`viewer markup is missing ${selector}`);
  return e;
}
const select = element("#item", HTMLSelectElement);
const stats = element("#stats", HTMLDivElement);
for (const name of itemNames()) select.add(new Option(name, name));

let current: { name: string; item: Item } | undefined;

async function show(name: string): Promise<{ triangles: number }> {
  if (current) stage.scene.remove(current.item.object);
  const item = await buildItem(name);
  current = { name, item };
  stage.scene.add(item.object);
  stage.setGround(item.ground);
  select.value = name;
  const count = triangles(item.object);
  stats.textContent = `${count.toLocaleString()} triangles`;
  const url = new URL(location.href);
  url.searchParams.set("item", name);
  history.replaceState(null, "", url);
  return { triangles: count };
}

/** Medium frames the overview box (default: the whole object) from the front-right; close frames the focus box. */
function view(kind: View): void {
  if (!current) return;
  const whole = new THREE.Box3().setFromObject(current.item.object);
  const box = (kind === "close" ? current.item.focus : current.item.overview) ?? whole;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const distance = (sphere.radius / Math.sin(fov / 2)) * (kind === "close" ? 0.75 : 1.05);
  const direction = (current.item.from?.clone() ?? new THREE.Vector3(0.55, kind === "close" ? 0.18 : 0.32, 1)).normalize();
  camera.position.copy(sphere.center).addScaledVector(direction, distance);
  camera.position.y = Math.max(camera.position.y, whole.min.y + sphere.radius * 0.05);
  camera.near = distance / 50;
  camera.far = distance * 1000;
  camera.updateProjectionMatrix();
  controls.target.copy(sphere.center);
  controls.update();
  // shadow texels follow the framing: the framed region and its surroundings, not the whole
  // object, so a 7 mm beetle on a 40 cm leaf gets shadows without acne
  const around = new THREE.Box3().setFromCenterAndSize(sphere.center, new THREE.Vector3().setScalar(sphere.radius * 12));
  stage.fitShadow(around.intersect(whole.clone().expandByScalar(sphere.radius * 0.5)));
  occlusion.radius.value = sphere.radius * 0.1;
  occlusion.distanceFallOff.value = 1;
}

select.addEventListener("change", () => void show(select.value).then(() => view("medium")));
for (const kind of ["close", "medium"] as const) document.querySelector(`#${kind}`)?.addEventListener("click", () => view(kind));
addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

function draw(): void {
  controls.update();
  post.render();
}
renderer.setAnimationLoop(draw);

/** Resolves once all textures have loaded and a few frames have drawn with them. */
async function settle(): Promise<void> {
  await idle;
  // compiling points the renderer at the scene pass until it is done: no frames meanwhile
  renderer.setAnimationLoop(null);
  await scene.compileAsync(renderer);
  renderer.setAnimationLoop(draw);
  for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
}

const api = { names: itemNames(), show, view, settle };
declare global {
  interface Window {
    viewer: typeof api;
  }
}
window.viewer = api;

await show(params.get("item") ?? itemNames()[0] ?? "house-1");
view(params.get("view") === "close" ? "close" : "medium");

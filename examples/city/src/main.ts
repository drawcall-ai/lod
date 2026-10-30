// The city showcase: a 4 × 4 km world from a seed, every kind of content on the levels
// that suit it, a scripted flight from two kilometres up to a ladybird, free flight.
// ?shot hides the overlay (scripts/tour.ts); ?seed=<n> changes the world; ?debug tints
// levels and ?quality=<q> sets Lod.quality from the start; ?terrain=0 leaves the ground
// mesh out (everything still stands where the ground would be; roads and the creek stay).
// ?wind=0 builds vegetation without wind, for a static performance baseline.
// window.city exposes the tour and frame measurements to scripts/tour.ts.
import { textures } from "./loading.ts";
import * as THREE from "three/webgpu";
import { InstancedLod, Lod, Wind, setViewportHeight } from "@drawcall/lod";
import { Library } from "../public/content/materials.ts";
import { number } from "../public/content/parameters.ts";
import { terrainMaterial } from "./render/ground/material.ts";
import { Fly } from "./flight/fly.ts";
import { route } from "./flight/route.ts";
import { Tour } from "./flight/tour.ts";
import { haze } from "./render/haze.ts";
import { Pipeline } from "./render/pipeline.ts";
import { Sun } from "./render/sun/index.ts";
import { loadSky } from "./render/sky.ts";
import { diagnostics } from "./diagnostics.ts";
import { Ui } from "./ui.ts";
import { Corn } from "./world/corn/index.ts";
import { groundCover } from "./world/ground-cover.ts";
import { water } from "./world/creek.ts";
import { houses } from "./world/houses.ts";
import { Patches } from "./world/patches.ts";
import { TOWN } from "./world/plan.ts";
import { loadPlan } from "./world/plan/cache.ts";
import { EXTENT } from "./world/terrain.ts";
import { props } from "./world/props.ts";
import { roads } from "./world/roads.ts";
import { trees } from "./world/trees.ts";

const params = new URLSearchParams(location.search);
const shot = params.has("shot");
const terrain = params.get("terrain") !== "0";
Lod.debug = params.has("debug");
Lod.quality = number(params, "quality", 1, 0.01, 100);
if (shot) document.body.classList.add("shot");
const started = performance.now();
const loadStages: Record<string, number> = {};
const loaded = (name: string) => {
  loadStages[name] = performance.now() - started;
  performance.mark(`city:${name}`);
};

const ui = new Ui();
THREE.DefaultLoadingManager.onProgress = (url, loaded, total) => ui.progress(`Loading ${url.split("/").pop()} (${loaded}/${total})`, (0.85 * loaded) / total);

const library = new Library(THREE.DefaultLoadingManager, new URL("/assets/", location.href).href, textures);
await library.load();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.5, 60000);
const scene = new THREE.Scene();
const pipeline = await Pipeline.create(scene, camera, Math.min(devicePixelRatio, 2));
loaded("renderer");
// hidden until the world is built: an empty canvas would sit over the page meanwhile
pipeline.canvas.style.visibility = "hidden";
document.body.prepend(pipeline.canvas);

// late afternoon: the sun low in the south-west, raking across the town
const [world, sky] = await Promise.all([loadPlan(number(params, "seed", 7, 0, 2 ** 32 - 1, true)), loadSky(library, pipeline.renderer, 2.4)]);
loaded("plan and sky");
scene.background = sky.background;
scene.environment = sky.environment;
scene.backgroundRotation.y = scene.environmentRotation.y = sky.turn;
// The HDRI's sun stands 48° high; lower it to 27° for long shadows and warmer light. Its
// disc in the sky image stays where it was, out of the tour's views.
const sunward = new THREE.Vector3(sky.sun.x, 0, sky.sun.z).normalize().multiplyScalar(Math.cos(0.47)).setY(Math.sin(0.47));
const sun = new Sun(sunward);
sun.light.color.set("#ffe0bc");
sun.light.intensity = sky.irradiance * 1.15;
scene.add(...sun.objects);
scene.fogNode = haze(
  sky.horizon.clone().multiply(new THREE.Color(0.86, 0.92, 1.0)),
  1.7e-4,
  sunward,
  new THREE.Color(1, 0.86, 0.66).multiplyScalar(sky.horizon.r + sky.horizon.g + sky.horizon.b),
);

const zones = { fields: world.fields, forests: world.forests, parcels: { texture: world.land.texture(), extent: EXTENT }, town: TOWN };
const wind = params.get("wind") === "0" ? undefined : new Wind({ direction: [1, 0.35], speed: 0.22 });
const content = Promise.all([houses(world), trees(world, wind), props(world), Corn.build(world), groundCover(library, world, zones, wind)]);
// Let cache discovery start before constructing the ground on this thread.
await new Promise<void>((resolve) => setTimeout(resolve, 0));
if (terrain) {
  const ground = world.terrain.mesh(terrainMaterial(library, zones));
  // the ground's shader is the costliest per pixel and much of it ends up under corn, grass
  // and houses: drawn last of the opaque objects, depth testing skips what they cover
  ground.renderOrder = 1;
  scene.add(ground);
}
scene.add(roads(library, world), water(world.terrain));

const [buildings, forest, objects, corn, herbage] = await content;
loaded("content");
scene.add(buildings, forest, objects, corn, herbage);
if (wind) corn.applyWind(wind);
scene.updateMatrixWorld(true);
scene.matrixWorldAutoUpdate = false;
sun.castBy(scene);
const lods: (Lod | InstancedLod)[] = [];
const patches: Patches[] = [];
scene.traverse((object) => {
  if (object instanceof Patches) patches.push(object);
  if (!(object instanceof Lod || object instanceof InstancedLod)) return;
  lods.push(object);
  object.addEventListener("levelschange", () => {
    sun.castBy(object);
  });
});
const kinds = [
  { name: "houses", roots: [buildings] },
  { name: "trees", roots: [forest] },
  { name: "props", roots: [objects] },
  { name: "corn covers", roots: corn.covers.map((cover) => cover.lod) },
  { name: "corn plants", roots: [corn.plants, corn.hero] },
  { name: "ladybird", roots: [corn.ladybird] },
  { name: "ground cover", roots: [herbage] },
];

const tour = new Tour(route(world, corn.anchors));
const playback: { time: number; requested?: number; playing: boolean } = { time: 0, playing: !shot };
const fly = new Fly(pipeline.canvas, camera, (at) => at.y - world.terrain.height(at.x, at.z));
ui.bind(
  {
    duration: tour.duration,
    toggle: () => {
      fly.release();
      playback.playing = !playback.playing;
      if (playback.playing && playback.time >= tour.duration) playback.requested = 0;
      return playback.playing;
    },
    seek: (t) => {
      fly.release();
      playback.playing = false;
      playback.requested = t;
    },
  },
  wind,
);

let viewportVersion = 0;
function resize(): void {
  viewportVersion++;
  pipeline.setSize(innerWidth, innerHeight);
  Patches.height = innerHeight;
  setViewportHeight(camera, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

let focus = tour.pose(playback.time, camera);
function fitCamera(value: number): void {
  camera.near = THREE.MathUtils.clamp(value * 0.02, 0.0002, 2);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

/** How far the nearest surface is at least: the camera's height above the ground, less 80 m for what stands on it. */
function clearance(): number {
  return camera.position.y - world.terrain.height(camera.position.x, camera.position.z) - 80;
}

/** Every live frame advances and renders; resident coarse levels cover deferred detail. */
function frame(dt: number): void {
  if (wind) wind.time += dt;
  playback.time = playback.requested ?? (playback.playing ? Math.min(playback.time + dt, tour.duration) : playback.time);
  playback.requested = undefined;
  playback.playing &&= playback.time < tour.duration;
  focus = fly.touched ? fly.update(dt) : tour.pose(playback.time, camera);
  fitCamera(focus);
  sun.update(camera, focus, clearance());
  Patches.beginFrame();
  corn.update(camera);
  for (const patch of patches) if (patch !== corn.plants) patch.update(camera);
  pipeline.render();
}

fitCamera(focus);
sun.update(camera, focus, clearance());
ui.progress("Preparing the first view…", 0.85);
await library.ready(scene);
loaded("textures");
// Select resident levels before compiling the first view.
for (const lod of lods) {
  lod.autoUpdate = false;
  lod.update(camera);
}
await pipeline.compile();
loaded("compiled");
for (;;) {
  const version = viewportVersion;
  await pipeline.step(() => frame(0));
  await pipeline.wait();
  if (version === viewportVersion) break;
}
for (const lod of lods) lod.autoUpdate = true;
const loadMs = performance.now() - started;
loaded("first frame");
ui.ready();
pipeline.canvas.style.visibility = "visible";

let last = performance.now();
let shown = 0;
let frameMs = 16;
/** The live loop: tour or free flight, and the overlay. */
function live(): void {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  frameMs += (now - last - frameMs) * 0.1;
  last = now;
  frame(dt);
  void pipeline.timing();
  ui.showTime(playback.time, playback.playing);
  if (now - shown < 250) return;
  shown = now;
  ui.showStats({ ms: frameMs, gpu: pipeline.gpuMs, ...pipeline.drawn });
}
pipeline.renderer.setAnimationLoop(live);
window.city = diagnostics({
  loadMs,
  loadStages,
  pipeline,
  wind,
  tour,
  sun,
  lods,
  patches,
  kinds,
  playback,
  frame: () => frame(0),
  resume: () => pipeline.renderer.setAnimationLoop(live),
  seek: (time) => {
    fly.release();
    playback.playing = false;
    playback.requested = undefined;
    playback.time = time;
    focus = tour.pose(time, camera);
    fitCamera(focus);
  },
});

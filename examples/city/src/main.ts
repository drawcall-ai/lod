// The city showcase: a 4 × 4 km world from a seed, every kind of content on the levels
// that suit it, a scripted flight from two kilometres up to a ladybird, free flight.
// ?shot hides the overlay (scripts/tour.ts); ?seed=<n> changes the world; ?debug tints
// levels and ?quality=<q> sets Lod.quality from the start; ?terrain=0 leaves the ground
// mesh out (everything still stands where the ground would be; roads and the creek stay).
// ?wind=0 builds vegetation without wind, for a static performance baseline.
// Forests and ground cover are planted on the GPU in the tiles near the camera (world/near-tiles.ts, world/planting.ts).
// window.city exposes the tour and frame measurements to scripts/tour.ts.
import * as THREE from "three/webgpu";
import { Lod, Wind } from "@drawcall/lod";
import { Textures } from "./render/materials.ts";
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
import { NearTiles } from "./world/near-tiles.ts";
import { CachedPlanLoader } from "./world/plan/loader.ts";
import { plan, TOWN } from "./world/plan.ts";
import { manager } from "./loading.ts";
import { EXTENT } from "./world/terrain.ts";
import { props } from "./world/props.ts";
import { roads } from "./world/roads.ts";
import { trees } from "./world/trees.ts";

/** The default seed's plan is cached: planning takes seconds. */
const loadPlan = async (seed: number) => (seed === 7 ? new CachedPlanLoader().loadAsync({ seed: 7 }) : plan(seed));

const params = new URLSearchParams(location.search);
const shot = params.has("shot");
const terrain = params.get("terrain") !== "0";
Lod.debug = params.has("debug");
const quality = params.get("quality") ?? "1";
if (!(/^\d+(\.\d+)?$/.test(quality) && Number(quality) >= 0.01 && Number(quality) <= 100)) throw new Error(`quality must be in [0.01, 100], not ${quality}`);
Lod.quality = Number(quality);
const seed = params.get("seed") ?? "7";
if (!(/^\d+$/.test(seed) && Number(seed) < 2 ** 32)) throw new Error(`seed must be a whole number below 2^32, not ${seed}`);
if (shot) document.body.classList.add("shot");
const started = performance.now();
const loadStages: Record<string, number> = {};
const loaded = (name: string) => {
  loadStages[name] = performance.now() - started;
  performance.mark(`city:${name}`);
};

const ui = new Ui();
// Each Lod holds an item on `lodManager` while the levels its view needs arrive: `loading` tells when the first view
// is complete.
const lodManager = new THREE.LoadingManager();
let loading = false;
lodManager.onStart = () => (loading = true);
lodManager.onLoad = () => (loading = false);
manager.onProgress = (url, loaded, total) => {
  ui.progress(`Loading ${url.split("/").pop()} (${loaded}/${total})`, (0.85 * loaded) / total);
};

const textures = new Textures(manager);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.5, 60000);
const scene = new THREE.Scene();
const pipeline = await Pipeline.create(scene, camera, Math.min(devicePixelRatio, 2));
loaded("renderer");
// hidden until the world is built: an empty canvas would sit over the page meanwhile
pipeline.canvas.style.visibility = "hidden";
document.body.prepend(pipeline.canvas);

// late afternoon: the sun low in the south-west, raking across the town
const [world, sky] = await Promise.all([loadPlan(Number(seed)), loadSky(manager, pipeline.renderer, 2.4)]);
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
const content = Promise.all([
  houses(world),
  trees(world, pipeline.renderer, wind),
  props(world),
  Corn.build(world),
  groundCover(textures, world, zones, camera, pipeline.renderer, wind),
]);
// Let cache discovery start before constructing the ground on this thread.
await new Promise<void>((resolve) => setTimeout(resolve, 0));
if (terrain) {
  const ground = world.terrain.mesh(terrainMaterial(textures, zones));
  // the ground's shader is the costliest per pixel and much of it ends up under corn, grass
  // and houses: drawn last of the opaque objects, depth testing skips what they cover
  ground.renderOrder = 1;
  scene.add(ground);
}
scene.add(roads(textures, world), water(world.terrain));

const [buildings, forest, objects, corn, herbage] = await content;
loaded("content");
scene.add(buildings, forest, objects, corn, herbage);
if (wind) corn.applyWind(wind);
scene.updateMatrixWorld(true);
scene.matrixWorldAutoUpdate = false;
sun.castBy(scene);
const lods: Lod[] = [];
const nearTiles: NearTiles[] = [];
scene.traverse((object) => {
  if (object instanceof NearTiles) nearTiles.push(object);
  if (!(object instanceof Lod)) return;
  lods.push(object);
  object.manager = lodManager;
  object.addEventListener("levelschange", () => {
    sun.castBy(object);
  });
});
/** The forests and ground cover; corn updates its own tiles. */
const planted = nearTiles.filter((tiles) => tiles !== corn.plants);
const kinds = [
  { name: "houses", roots: [buildings] },
  { name: "trees", roots: [forest] },
  { name: "props", roots: [objects] },
  { name: "corn blocks", roots: corn.blocks.map((block) => block.lod) },
  { name: "corn plants", roots: [...corn.plantLods, corn.hero] },
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

/**
 * Every live frame advances and renders; a level still loading draws as a loaded coarser one, and nothing draws until
 * the coarsest has loaded.
 */
function frame(dt: number): void {
  if (wind) wind.time += dt;
  playback.time = playback.requested ?? (playback.playing ? Math.min(playback.time + dt, tour.duration) : playback.time);
  playback.requested = undefined;
  playback.playing &&= playback.time < tour.duration;
  focus = fly.touched ? fly.update(dt) : tour.pose(playback.time, camera);
  fitCamera(focus);
  sun.update(camera, focus, clearance());
  corn.update(camera, innerHeight);
  for (const tiles of planted) tiles.update(camera.position);
  pipeline.render();
}

fitCamera(focus);
sun.update(camera, focus, clearance());
ui.progress("Preparing the first view…", 0.85);
await textures.ready();
loaded("textures");
await pipeline.compile();
loaded("compiled");
// Render the first view until its levels and shadows have arrived, and while the viewport changes meanwhile.
for (;;) {
  const version = viewportVersion;
  await pipeline.step(() => frame(0));
  await pipeline.wait();
  if (version === viewportVersion && !loading) break;
}
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
  camera,
  wind,
  tour,
  sun,
  lods,
  nearTiles,
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

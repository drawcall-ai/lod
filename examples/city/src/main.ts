// The city showcase: a 4 × 4 km world from a seed, every kind of content on the levels
// that suit it, a scripted flight from two kilometres up to a ladybird, free flight.
// ?shot hides the overlay (scripts/tour.ts); ?seed=<n> changes the world; ?debug tints
// levels and ?quality=<q> sets Lod.quality from the start; ?terrain=0 leaves the ground
// mesh out (everything still stands where the ground would be; roads and the creek stay).
// window.city exposes the tour and frame measurements to scripts/tour.ts.
import * as THREE from "three";
import { Lod } from "@drawcall/lod";
import { loadManifest } from "./content/materials.ts";
import { terrainMaterial } from "./content/terrain.ts";
import { Fly } from "./flight/fly.ts";
import { route } from "./flight/route.ts";
import { Tour } from "./flight/tour.ts";
import { building } from "./loading.ts";
import { installHaze } from "./render/haze.ts";
import { Pipeline } from "./render/pipeline.ts";
import { Sun } from "./render/sun/index.ts";
import { loadSky } from "./render/sky.ts";
import { levelCounts } from "./stats.ts";
import { Ui } from "./ui.ts";
import { Corn } from "./world/corn/index.ts";
import { cover } from "./world/cover.ts";
import { water } from "./world/creek.ts";
import { houses } from "./world/houses.ts";
import { Patches } from "./world/patches.ts";
import { plan, TOWN } from "./world/plan.ts";
import { EXTENT } from "./world/terrain.ts";
import { props } from "./world/props.ts";
import { roads } from "./world/roads.ts";
import { trees } from "./world/trees.ts";

const params = new URLSearchParams(location.search);
const shot = params.has("shot");
const terrain = params.get("terrain") !== "0";
Lod.debug = params.has("debug");
Lod.quality = Number(params.get("quality") ?? 1);
if (shot) document.body.classList.add("shot");
const started = performance.now();

const ui = new Ui();
THREE.DefaultLoadingManager.onProgress = (url, loaded, total) => ui.progress(`Downloading ${url.split("/").pop()} (${loaded}/${total})`, loaded / total / 4);
building.onProgress = (name, loaded, total) => ui.progress(`Building ${name}…`, 0.25 + (0.75 * loaded) / Math.max(total, 14));

await loadManifest();
const pipeline = new Pipeline({ preserveDrawingBuffer: shot, pixelRatio: Math.min(devicePixelRatio, 2) });
// hidden until the world is built: an empty canvas would sit over the page meanwhile
pipeline.canvas.style.visibility = "hidden";
document.body.prepend(pipeline.canvas);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.5, 60000);
const scene = new THREE.Scene();

// late afternoon: the sun low in the south-west, raking across the town
const sky = await loadSky(pipeline.renderer, 2.4);
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
const haze = sky.horizon.clone().multiply(new THREE.Color(0.86, 0.92, 1.0));
installHaze(sunward, new THREE.Color(1, 0.86, 0.66).multiplyScalar(sky.horizon.r + sky.horizon.g + sky.horizon.b));
scene.fog = new THREE.FogExp2(haze, 1.7e-4);

const world = plan(Number(params.get("seed") ?? 7));
const zones = { fields: world.fields, forests: world.forests, parcels: { texture: world.land.texture(), extent: EXTENT }, town: TOWN };
if (terrain) {
  const ground = world.terrain.mesh(terrainMaterial(zones));
  // the ground's shader is the costliest per pixel and much of it ends up under corn, grass
  // and houses: drawn last of the opaque objects, depth testing skips what they cover
  ground.renderOrder = 1;
  scene.add(ground);
}
scene.add(roads(world), water(world.terrain));

const houseLods = await houses(world);
const treeLods = await trees(world);
const propLods = await props(world);
const corn = await Corn.build(world);
const groundCover = await cover(world, zones);
scene.add(...houseLods, ...treeLods, ...propLods, corn, ...groundCover);
sun.castBy(scene);
/** The content by kind, each counted on its own. */
const kinds = [
  { name: "houses", roots: houseLods },
  { name: "trees", roots: treeLods },
  { name: "props", roots: propLods },
  { name: "corn covers", roots: corn.covers.map((c) => c.lod) },
  { name: "corn plants", roots: [corn.plants, corn.hero] },
  { name: "ladybird", roots: [corn.ladybird] },
  { name: "ground cover", roots: groundCover },
];

const tour = new Tour(route(world, corn));
let time = 0;
let playing = !shot;
const fly = new Fly(pipeline.canvas, camera, (at) => at.y - world.terrain.height(at.x, at.z));
ui.bind({
  duration: tour.duration,
  toggle: () => {
    fly.release();
    playing = !playing;
    if (playing && time >= tour.duration) time = 0;
    return playing;
  },
  seek: (t) => {
    fly.release();
    playing = false;
    time = t;
  },
});

function resize(): void {
  pipeline.setSize(innerWidth, innerHeight);
  Patches.height = innerHeight;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

/** Moves the camera by `dt` seconds of tour or flight and draws a frame. */
function frame(dt: number): void {
  let focus: number;
  if (fly.touched) focus = fly.update(dt);
  else {
    if (playing) time = Math.min(time + dt, tour.duration);
    playing &&= time < tour.duration;
    focus = tour.pose(time, camera);
  }
  // near and far follow the scale of the view; reversed float depth keeps both ends sharp
  camera.near = THREE.MathUtils.clamp(focus * 0.02, 0.0002, 2);
  camera.far = 60000;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  // nothing stands much more than 40 m above the ground or rises far above where the camera is over it
  const clear = camera.position.y - world.terrain.height(camera.position.x, camera.position.z) - 80;
  sun.update(camera, focus, clear);
  pipeline.render(scene, camera);
}

await pipeline.renderer.compileAsync(scene, camera);
const loadMs = performance.now() - started;
ui.ready();
pipeline.canvas.style.visibility = "visible";

let last = performance.now();
let shown = 0;
let frameMs = 16;
pipeline.renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  frameMs += (now - last - frameMs) * 0.1;
  last = now;
  frame(dt);
  ui.showTime(time, playing);
  if (now - shown < 250) return;
  shown = now;
  ui.showStats({ ms: frameMs, gpu: pipeline.gpuMs, ...pipeline.drawn }, counts());
});

function counts() {
  return kinds.map(({ name, roots }) => ({ name, levels: levelCounts(roots) }));
}

/** For scripts/tour.ts: jump along the tour and time frames there. */
const api = {
  loadMs,
  keys: tour.keys.map((k) => ({ name: k.name, time: k.time })),
  /** Stop the tour at `t` seconds and draw a few frames so every patch fills and every fade settles. */
  seek(t: number): void {
    fly.release();
    playing = false;
    time = t;
    for (let i = 0; i < 4; i++) frame(0);
  },
  /**
   * Times frames at the current pose: `runs` times, `frames` frames back to back with one
   * wait for the GPU after the last, so CPU and GPU overlap as in the live loop. `ms` is
   * the median run's time per frame, `cpu` the median time of one frame's CPU work. With
   * `move`, each frame of a run moves on that many seconds of tour from the pose, which
   * comes back after. What was drawn is the pose's own frame.
   */
  measure(frames: number, runs: number, move = 0) {
    const gl = pipeline.renderer.getContext();
    const pixel = new Uint8Array(4);
    const wait = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const start = time;
    const perFrame: number[] = [];
    const cpu: number[] = [];
    wait();
    for (let r = 0; r < runs; r++) {
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        time = start + i * move;
        const t1 = performance.now();
        frame(0);
        cpu.push(performance.now() - t1);
      }
      wait();
      perFrame.push((performance.now() - t0) / frames);
    }
    time = start;
    frame(0);
    wait();
    const median = (list: number[]) => list.sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0;
    return {
      ms: median(perFrame),
      cpu: median(cpu),
      ...pipeline.drawn,
      kinds: counts(),
      cascades: sun.cascades.map((c) => ({ ...c.drawn })),
    };
  },
};
declare global {
  interface Window {
    city: typeof api;
  }
}
window.city = api;

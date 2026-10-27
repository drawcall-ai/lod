// The city showcase: a 4 × 4 km world from a seed, every kind of content on the levels
// that suit it, a scripted flight from two kilometres up to a ladybird, free flight.
// ?shot hides the overlay (scripts/tour.ts); ?seed=<n> changes the world; ?debug tints
// levels and ?quality=<q> sets Lod.quality from the start; ?terrain=0 leaves the ground
// mesh out (everything still stands where the ground would be; roads and the creek stay).
// ?wind=0 builds vegetation without wind, for a static performance baseline.
// window.city exposes the tour and frame measurements to scripts/tour.ts.
import * as THREE from "three/webgpu";
import { type InstancedLod, Lod, Wind } from "@drawcall/lod";
import { loadManifest } from "./content/materials.ts";
import { terrainMaterial } from "./content/terrain.ts";
import { Fly } from "./flight/fly.ts";
import { route } from "./flight/route.ts";
import { Tour } from "./flight/tour.ts";
import { building } from "./loading.ts";
import { haze } from "./render/haze.ts";
import { Pipeline } from "./render/pipeline.ts";
import { prepare } from "./render/prepare.ts";
import { Sun } from "./render/sun/index.ts";
import { loadSky } from "./render/sky.ts";
import { Counts } from "./stats.ts";
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
building.onProgress = (name, loaded, total) => ui.progress(`Building ${name}…`, 0.25 + (0.6 * loaded) / Math.max(total, 14));

await loadManifest();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.5, 60000);
const scene = new THREE.Scene();
const pipeline = await Pipeline.create(scene, camera, Math.min(devicePixelRatio, 2));
// hidden until the world is built: an empty canvas would sit over the page meanwhile
pipeline.canvas.style.visibility = "hidden";
document.body.prepend(pipeline.canvas);

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
scene.fogNode = haze(
  sky.horizon.clone().multiply(new THREE.Color(0.86, 0.92, 1.0)),
  1.7e-4,
  sunward,
  new THREE.Color(1, 0.86, 0.66).multiplyScalar(sky.horizon.r + sky.horizon.g + sky.horizon.b),
);

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

const wind = params.get("wind") === "0" ? undefined : new Wind({ direction: [1, 0.35], speed: 0.22 });
if (wind) {
  sway(wind, treeLods, 0.025);
  for (const patches of groundCover) sway(wind, patches.lods, 0.07);
  sway(wind, corn.plants.lods, 0.04);
  // The millimetre close-up follows the ladybird's rest-pose seat on the hero plant.
  // Its separate insect Lod and the distant field covers stay still.
}

/** Top displacement as a share of plant height, so small plants never sway like trees. */
function sway(wind: Wind, lods: InstancedLod[], fraction: number): void {
  for (const lod of lods) {
    const source = lod.levels[0];
    if (!source) throw new Error(`${lod.name}: no source level for wind`);
    const box = new THREE.Box3().setFromObject(source.object);
    wind.apply(lod, { amplitude: (box.max.y - box.min.y) * fraction });
  }
}
sun.castBy(scene);
// Scene transforms are fixed: patches change instance buffers and wind runs in the
// shaders. The camera and the cascades' lights live outside this tree and update themselves.
scene.matrixWorldAutoUpdate = false;
/** The content by kind, each counted on its own. */
const kinds = [
  { name: "houses", roots: houseLods },
  { name: "trees", roots: treeLods },
  { name: "props", roots: propLods },
  { name: "corn covers", roots: corn.covers.map((c) => c.lod) },
  { name: "corn plants", roots: [corn.plants, corn.hero] },
  { name: "ladybird", roots: [corn.ladybird] },
  { name: "ground cover", roots: groundCover },
].map(({ name, roots }) => ({ name, counts: new Counts(roots) }));

const tour = new Tour(route(world, corn));
let time = 0;
let playing = !shot;
const fly = new Fly(pipeline.canvas, camera, (at) => at.y - world.terrain.height(at.x, at.z));
ui.bind(
  {
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
  },
  wind,
);

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
  if (wind) wind.time += dt;
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
  pipeline.render();
}

await prepare(
  scene,
  pipeline,
  sun.cascades.map(({ light }) => light.shadow),
  (done, total) => ui.progress("Preparing scene…", 0.85 + (0.15 * done) / total),
);
// The empty preparation draws leave empty shadow maps. Draw the real starting
// view, with normal selection and streaming, before showing the canvas.
await new Promise<void>((resolve, reject) =>
  pipeline.renderer.setAnimationLoop(() => {
    pipeline.renderer.setAnimationLoop(null);
    try {
      frame(0);
      resolve();
    } catch (error) {
      reject(error);
    }
  }),
);
await pipeline.wait();
const loadMs = performance.now() - started;
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
  ui.showTime(time, playing);
  if (now - shown < 250) return;
  shown = now;
  ui.showStats({ ms: frameMs, gpu: pipeline.gpuMs, ...pipeline.drawn }, counts());
}
pipeline.renderer.setAnimationLoop(live);

/**
 * Draws `count` frames at the current pose, `before(i)` setting up frame i, each in a tick
 * of the renderer's animation loop: three starts a frame, and redraws shadow maps, only
 * there. Each frame's timer resolves before the next draws. The live loop stays stopped after, so that
 * no frame of its own lands in a measurement: `resume` starts it again.
 */
async function draw(count: number, before: (i: number) => void): Promise<Array<{ cpu: number; gpu: number | null }>> {
  pipeline.renderer.setAnimationLoop(null);
  await pipeline.timing();
  const frames: Array<{ cpu: number; gpu: number | null }> = [];
  for (let i = 0; i < count; i++) {
    const cpu = await new Promise<number>((resolve) =>
      pipeline.renderer.setAnimationLoop(() => {
        pipeline.renderer.setAnimationLoop(null);
        before(i);
        const t = performance.now();
        frame(0);
        resolve(performance.now() - t);
      }),
    );
    frames.push({ cpu, gpu: await pipeline.timing() });
  }
  return frames;
}

const resume = () => pipeline.renderer.setAnimationLoop(live);

function counts() {
  return kinds.map(({ name, counts }) => ({ name, levels: counts.read() }));
}

/** For scripts/tour.ts: jump along the tour and time frames there. */
const api = {
  loadMs,
  wind,
  keys: tour.keys.map((k) => ({ name: k.name, time: k.time })),
  /** Stop the tour at `t` seconds and draw a few frames so every patch fills and every fade settles. */
  async seek(t: number): Promise<void> {
    fly.release();
    playing = false;
    time = t;
    await draw(4, () => {});
    resume();
  },
  /**
   * Times frames at the current pose: `runs` times, `frames` frames, one per tick of the
   * animation loop. `ms` is the median run's sum of GPU pass durations per frame (the
   * loop waits for the display between frames), `cpu` the median time of one frame's
   * CPU work. GPU passes can overlap: their sum is not elapsed frame latency.
   * With `move`, each frame of a run moves on that many seconds of tour from
   * the pose, which comes back after. Wind advances at 60 Hz in both cases. What was
   * drawn is the pose's own frame.
   */
  async measure(frames: number, runs: number, move = 0) {
    if (!pipeline.renderer.hasFeature("timestamp-query")) throw new Error("measure needs the GPU's timer (timestamp-query), which this browser does not offer");
    const start = time;
    const breeze = wind?.time ?? 0;
    const perFrame: number[] = [];
    const cpu: number[] = [];
    for (let r = 0; r < runs; r++) {
      const each = await draw(frames, (i) => {
        time = start + i * move;
        if (wind) wind.time = breeze + i / 60;
      });
      let gpu = 0;
      for (const frame of each) {
        if (frame.gpu === null) throw new Error("measure: a frame has no GPU timing");
        gpu += frame.gpu;
        cpu.push(frame.cpu);
      }
      perFrame.push(gpu / frames);
    }
    time = start;
    if (wind) wind.time = breeze;
    await draw(1, () => {});
    resume();
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

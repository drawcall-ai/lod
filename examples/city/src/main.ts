// The city showcase: a 4 × 4 km world from a seed, every kind of content on the levels
// that suit it, a scripted flight from two kilometres up to a ladybird, free flight.
// ?shot hides the overlay (scripts/tour.ts); ?seed=<n> changes the world; ?debug tints
// levels and ?quality=<q> sets Lod.quality from the start; ?terrain=0 leaves the ground
// mesh out (everything still stands where the ground would be; roads and the creek stay).
// ?wind=0 builds vegetation without wind, for a static performance baseline.
// window.city exposes the tour and frame measurements to scripts/tour.ts.
import * as THREE from "three/webgpu";
import { InstancedLod, Lod, Wind, setViewportHeight } from "@drawcall/lod";
import { loadManifest } from "./content/materials.ts";
import { terrainMaterial } from "./content/terrain.ts";
import { Fly } from "./flight/fly.ts";
import { route } from "./flight/route.ts";
import { Tour } from "./flight/tour.ts";
import { building, downloaded } from "./loading.ts";
import { haze } from "./render/haze.ts";
import { Pipeline } from "./render/pipeline.ts";
import { prefetch, loadLevels } from "./render/prepare.ts";
import { Sun } from "./render/sun/index.ts";
import { loadSky } from "./render/sky.ts";
import { Counts } from "./stats.ts";
import { Ui } from "./ui.ts";
import { Corn } from "./world/corn/index.ts";
import { cover } from "./world/cover.ts";
import { water } from "./world/creek.ts";
import { houses } from "./world/houses.ts";
import { Patches } from "./world/patches.ts";
import { TOWN } from "./world/plan.ts";
import { loadPlan } from "./world/plan/cache.ts";
import type { Family } from "./world/stream.ts";
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
const [world, sky] = await Promise.all([loadPlan(Number(params.get("seed") ?? 7)), loadSky(pipeline.renderer, 2.4)]);
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
const content = Promise.all([houses(world, pipeline.renderer), trees(world), props(world), Corn.build(world), cover(world, zones)]);
// Let cache discovery start before constructing the ground on this thread.
await new Promise<void>((resolve) => setTimeout(resolve, 0));
if (terrain) {
  const ground = world.terrain.mesh(terrainMaterial(zones));
  // the ground's shader is the costliest per pixel and much of it ends up under corn, grass
  // and houses: drawn last of the opaque objects, depth testing skips what they cover
  ground.renderOrder = 1;
  scene.add(ground);
}
scene.add(roads(world), water(world.terrain));

const [houseFamily, treeFamilies, propFamily, corn, coverFamily] = await content;
const families: Family[] = [houseFamily, ...treeFamilies, propFamily, corn, coverFamily];
scene.add(...families.map((family) => family.object));

const wind = params.get("wind") === "0" ? undefined : new Wind({ direction: [1, 0.35], speed: 0.22 });
if (wind) for (const family of families) family.applyWind(wind);
// Fixed objects keep their transforms; streamed replacements update theirs once.
scene.matrixWorldAutoUpdate = false;
const watched = new WeakSet<THREE.Object3D>();
function watch(): void {
  scene.updateMatrixWorld(true);
  sun.castBy(scene);
  scene.traverse((object) => {
    if (!(object instanceof Lod || object instanceof InstancedLod) || watched.has(object)) return;
    watched.add(object);
    object.addEventListener("levelschange", () => sun.castBy(scene));
  });
  for (const cascade of sun.cascades) cascade.light.shadow.needsUpdate = true;
}
/** Rebuild immutable count metadata only when a family replaces its roots. */
const kinds = [
  { name: "houses", roots: () => [houseFamily.object] },
  { name: "trees", roots: () => treeFamilies.map((family) => family.object) },
  { name: "props", roots: () => [propFamily.object] },
  { name: "corn covers", roots: () => corn.covers.map((c) => c.lod) },
  { name: "corn plants", roots: () => (corn.ready ? [corn.plants, corn.hero] : []) },
  { name: "ladybird", roots: () => (corn.ready ? [corn.ladybird] : []) },
  { name: "ground cover", roots: () => [coverFamily.object] },
].map(({ name, roots }) => ({ name, roots, counts: new Counts(roots()) }));
for (const family of families)
  family.onReady = () => {
    watch();
    for (const kind of kinds) {
      kind.counts.dispose();
      kind.counts = new Counts(kind.roots());
    }
  };
watch();

const tour = new Tour(route(world, corn.anchors));
let time = 0;
let requested: number | undefined;
let playing = !shot;
const fly = new Fly(pipeline.canvas, camera, (at) => at.y - world.terrain.height(at.x, at.z));
ui.bind(
  {
    duration: tour.duration,
    toggle: () => {
      fly.release();
      playing = !playing;
      if (playing && time >= tour.duration) requested = 0;
      return playing;
    },
    seek: (t) => {
      fly.release();
      playing = false;
      requested = t;
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

// Camera movement commits only when all families needed by that view are ready.
// Offscreen casters count too; a far card must never replace a required near shadow.
const beforePosition = new THREE.Vector3();
const beforeRotation = new THREE.Quaternion();
let focus = tour.pose(time, camera);
let waiting: Promise<void> | undefined;
let failure: unknown;
const ready = new Set<Family>();
const requests = new Map<Family, Promise<void>>();
function request(family: Family): Promise<void> {
  let pending = requests.get(family);
  if (pending) return pending;
  pending = family
    .load()
    .then(() => loadLevels(family.object))
    .then(() => {
      ready.add(family);
    })
    .catch((error: unknown) => {
      failure = error;
      pipeline.renderer.setAnimationLoop(null);
      ui.waiting(`Could not load ${family.object.name}. Reload to retry.`);
      throw error;
    });
  requests.set(family, pending);
  return pending;
}
function fitCamera(value: number): void {
  camera.near = THREE.MathUtils.clamp(value * 0.02, 0.0002, 2);
  camera.far = 60000;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

/** Move and draw only when the requested view is complete; otherwise hold the last frame. */
function frame(dt: number): boolean {
  if (failure) throw failure;
  if (waiting) return false;
  if (wind) wind.time += dt;
  beforePosition.copy(camera.position);
  beforeRotation.copy(camera.quaternion);
  const nextTime = requested ?? (playing ? Math.min(time + dt, tour.duration) : time);
  const nextFocus = fly.touched ? fly.update(dt) : tour.pose(nextTime, camera);
  fitCamera(nextFocus);
  const needed = families.filter((family) => !ready.has(family) && family.needs(camera));
  if (needed.length) {
    const target = camera.clone();
    setViewportHeight(target, Patches.height);
    camera.position.copy(beforePosition);
    camera.quaternion.copy(beforeRotation);
    fitCamera(focus);
    ui.waiting("Loading this view…");
    // Let this frame finish before a source factory starts its synchronous work.
    waiting = new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(() => Promise.all(needed.map(request)))
      .then(() => prefetch(scene, target))
      .then(() => {
        waiting = undefined;
        if (!failure && pipeline.canvas.style.visibility === "visible") ui.ready();
      })
      .catch((error: unknown) => {
        if (!failure) {
          failure = error;
          pipeline.renderer.setAnimationLoop(null);
          ui.waiting("Could not load this view. Reload to retry.");
        }
        throw error;
      });
    return false;
  } else {
    focus = nextFocus;
    time = nextTime;
    requested = undefined;
    playing &&= time < tour.duration;
  }
  const clear = camera.position.y - world.terrain.height(camera.position.x, camera.position.z) - 80;
  sun.update(camera, focus, clear);
  pipeline.render();
  return true;
}

fitCamera(focus);
ui.progress("Loading the first view…", 0.85);
await Promise.all(families.filter((family) => !ready.has(family) && family.needs(camera)).map(request));
await prefetch(scene, camera);
await downloaded();
// Compile and upload only the actual first view, through its normal main/shadow passes.
// Other families and their graphics variants are prepared when they are requested.
for (;;) {
  const version = viewportVersion;
  const rendered = await new Promise<boolean>((resolve, reject) =>
    pipeline.renderer.setAnimationLoop(() => {
      pipeline.renderer.setAnimationLoop(null);
      try {
        resolve(frame(0));
      } catch (error) {
        reject(error);
      }
    }),
  );
  if (!rendered) {
    await waiting;
    continue;
  }
  await pipeline.wait();
  // A resize replaces render targets; reveal only a completed frame at the current size.
  if (version === viewportVersion) break;
}
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
  anticipate(now);
  void pipeline.timing();
  ui.showTime(time, playing);
  if (now - shown < 250) return;
  shown = now;
  ui.showStats({ ms: frameMs, gpu: pipeline.gpuMs, ...pipeline.drawn }, counts());
}
pipeline.renderer.setAnimationLoop(live);
// Prefetch only the upcoming tour view; a paused or static view keeps unused sources idle.
const ahead = camera.clone();
let predicted = 0;
function anticipate(now: number): void {
  if (!playing || fly.touched || now - predicted < 500) return;
  predicted = now;
  ahead.copy(camera);
  tour.pose(Math.min(time + 5, tour.duration), ahead);
  ahead.updateMatrixWorld();
  const needed = families.filter((family) => !requests.has(family) && family.needs(ahead));
  if (needed.length)
    setTimeout(() => {
      void Promise.all(needed.map(request));
    }, 0);
}

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
    pipeline.renderer.setAnimationLoop(null);
    await waiting;
    requested = undefined;
    time = t;
    focus = tour.pose(time, camera);
    fitCamera(focus);
    await Promise.all(families.filter((family) => !ready.has(family) && family.needs(camera)).map(request));
    await prefetch(scene, camera);
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
    // Measurements must not include asynchronous family replacement or live movement.
    pipeline.renderer.setAnimationLoop(null);
    await waiting;
    await Promise.all(families.map(request));
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

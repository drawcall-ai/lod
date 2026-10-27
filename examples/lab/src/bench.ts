import * as THREE from "three/webgpu";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { InstancedLod, LodLoader, type LevelRequest, type Lod } from "@drawcall/lod";
import { boundingSphere } from "../../../packages/lod/src/bounds.js";
import { errorOf } from "../../../packages/lod/src/levels.js";
import { K, camera, capture, freeTargets, renderer, scene } from "./capture.js";
import { at, must } from "./must.js";
import { context2d, glCanvas, gpuName } from "./page.js";
import { subject } from "./subjects.js";

// Standalone page (bench.html): every level the loader builds for a subject, measured
// against the source across on-screen heights. Driven by scripts/bench.ts through
// window.bench; the decisions (thresholds, defaults) are made there.
//
// - measure: each level and the source captured (see capture.ts) from several views;
//   colour difference where both cover and silhouette mismatch per edge pixel. The
//   floor is the source against itself shifted by half a supersample: what sampling
//   alone changes.
// - flicker: mean change per frame of a slow orbit at native resolution (MSAA, no
//   supersampling), as a ratio to the source's.
// - cost: GPU time per instance of an InstancedLod forced to one level, instances in
//   a grid at the measured height, filling the target.

// ------------------------------------------------------------------ subject and levels

export interface View {
  azimuth: number;
  elevation: number;
}

interface Prepared {
  source: THREE.Object3D;
  sphere: THREE.Sphere;
  /** one Lod of [source, level] per requested level */
  levels: Array<{ key: string; lod: Lod }>;
}
let prepared: Prepared | null = null;

const current = (): Prepared => must(prepared, "subject: call bench.prepare first");

/** The low shell as a .glb the loader can fetch by name, served from memory. */
async function shellManager(low: THREE.Object3D | undefined): Promise<THREE.LoadingManager> {
  const manager = new THREE.LoadingManager();
  if (!low) return manager;
  const glb = await new GLTFExporter().parseAsync(low, { binary: true });
  if (!(glb instanceof ArrayBuffer)) throw new Error("bench: the shell did not export as binary");
  const url = URL.createObjectURL(new Blob([glb], { type: "model/gltf-binary" }));
  manager.setURLModifier((requested) => (requested.endsWith("shell.glb") ? url : requested));
  return manager;
}

const triangles = (object: THREE.Object3D) => {
  let n = 0;
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || node instanceof THREE.InstancedMesh) return;
    const g: THREE.BufferGeometry = node.geometry;
    n += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
  });
  return n;
};

/**
 * Load `name` and build each requested level as its own `Lod` of [source, level], so
 * each keeps the maxPixels the loader predicts for it alone. A baked `low: "shell.glb"`
 * is the subject's authored low mesh; subjects without one skip that request.
 */
async function prepare(name: string, requests: Array<{ key: string; request: LevelRequest }>) {
  for (const { lod } of prepared?.levels ?? []) lod.dispose();
  const { load, low } = subject(name);
  const source = await load();
  const shell = low?.();
  const loader = new LodLoader(await shellManager(shell)).setPath("/");
  const sphere = boundingSphere(source);
  prepared = { source, sphere, levels: [] };
  const levels: Array<{ key: string; predicted: number; triangles: number; buildMs: number; error: number | null }> = [];
  for (const { key, request } of requests) {
    if (request.type === "baked" && request.low !== undefined && !shell) continue;
    const start = performance.now();
    const lod = await loader.parseAsync(source.clone(true), [request]);
    const buildMs = performance.now() - start;
    lod.forceLevel = 1;
    const level = at(lod.levels, 1);
    levels.push({ key, predicted: level.maxPixels, triangles: triangles(level.object), buildMs: Math.round(buildMs), error: errorOf(level.object) ?? null });
    prepared.levels.push({ key, lod });
  }
  sheet.reset(prepared.levels.map((l) => l.key));
  return { name, diameter: 2 * sphere.radius, triangles: triangles(source), levels };
}

function built(key: string): Lod {
  return must(
    current().levels.find((l) => l.key === key),
    `level "${key}"`,
  ).lod;
}

/** Canvas side for an object `height` px tall: the bounding sphere with a margin. */
const canvasSize = (height: number) => Math.ceil(height * 1.25 + 8);

/** Put the camera where the subject's bounding sphere measures `height` px on a `size` px canvas. */
function aim(view: View, height: number, size: number, turn = 0): void {
  const { center, radius } = current().sphere;
  const distance = (2 * radius * size) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * height);
  const e = THREE.MathUtils.degToRad(view.elevation);
  const a = THREE.MathUtils.degToRad(view.azimuth) + turn;
  camera.position
    .set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a))
    .multiplyScalar(distance)
    .add(center);
  camera.lookAt(center);
  camera.near = Math.max(distance - radius * 1.2, distance * 0.01);
  camera.far = distance + radius * 1.2;
  camera.aspect = 1;
  camera.updateProjectionMatrix();
}

// ------------------------------------------------------------------ measure

/** 0.25-step histogram of per-pixel colour difference, 0..255. */
const BINS = 1024;

interface Stats {
  colourSum: number;
  /** pixels both cover */
  both: number;
  /** signed luminance difference (level - source) summed where both cover */
  biasSum: number;
  histogram: number[];
  /** pixels exactly one covers */
  xor: number;
  /** covered pixels of the source with an uncovered 4-neighbour */
  perimeter: number;
}

const emptyStats = (): Stats => ({ colourSum: 0, both: 0, biasSum: 0, histogram: new Array<number>(BINS).fill(0), xor: 0, perimeter: 0 });

function score(reference: Uint8Array, image: Uint8Array, size: number, into: Stats): void {
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    const inRef = at(reference, o + 3) >= 128;
    const inImg = at(image, o + 3) >= 128;
    if (inRef !== inImg) into.xor++;
    if (inRef) {
      const x = i % size;
      const y = (i - x) / size;
      const out = (dx: number, dy: number) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx < 0 || ny < 0 || nx >= size || ny >= size || at(reference, (ny * size + nx) * 4 + 3) < 128;
      };
      if (out(1, 0) || out(-1, 0) || out(0, 1) || out(0, -1)) into.perimeter++;
    }
    if (!inRef || !inImg) continue;
    const [r, g, b] = [at(image, o) - at(reference, o), at(image, o + 1) - at(reference, o + 1), at(image, o + 2) - at(reference, o + 2)];
    const d = (Math.abs(r) + Math.abs(g) + Math.abs(b)) / 3;
    into.colourSum += d;
    into.biasSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    into.both++;
    const bin = Math.min(BINS - 1, Math.floor(d * 4));
    into.histogram[bin] = at(into.histogram, bin) + 1;
  }
}

/**
 * Every level in `keys` against the source at `height` px over `views`, and the floor.
 * With `sheetView` set, that view's images go into the contact sheet.
 */
async function measure(height: number, views: View[], keys: string[], sheetView = -1) {
  const { source } = current();
  const size = canvasSize(height);
  const floor = emptyStats();
  const levels: Record<string, Stats> = Object.fromEntries(keys.map((key) => [key, emptyStats()]));
  for (const [v, view] of views.entries()) {
    aim(view, height, size);
    const reference = await capture(source, size);
    if (!reference.some((value, i) => i % 4 === 3 && value > 0)) throw new Error(`bench: the source covers nothing at ${height} px`);
    score(reference, await capture(source, size, K, 0.5), size, floor);
    if (v === sheetView) sheet.draw("source", height, reference, size);
    for (const key of keys) {
      const image = await capture(built(key), size);
      score(reference, image, size, must(levels[key], key));
      if (v === sheetView) sheet.draw(key, height, image, size);
    }
  }
  freeTargets();
  return { floor, levels };
}

// ------------------------------------------------------------------ flicker

/** Channel `c` of pixel `p` of `pixels` (straight alpha) over mid grey. */
const overGrey = (pixels: Uint8Array, p: number, c: number) => {
  const alpha = at(pixels, p + 3) / 255;
  return at(pixels, p + c) * alpha + 128 * (1 - alpha);
};

/** Mean change per pixel (0..1, over grey) between consecutive frames of a slow orbit. */
async function orbitChange(object: THREE.Object3D, view: View, height: number, steps: number): Promise<number> {
  const size = canvasSize(height);
  // A quarter pixel per frame at the bounding sphere's edge.
  const step = 0.25 / (height / 2);
  let previous: Uint8Array | null = null;
  let change = 0;
  for (let i = 0; i < steps; i++) {
    aim(view, height, size, i * step);
    const frame = await capture(object, size, 1);
    if (previous) {
      let sum = 0;
      for (let p = 0; p < frame.length; p += 4)
        for (let c = 0; c < 3; c++) {
          sum += Math.abs(overGrey(frame, p, c) - overGrey(previous, p, c));
        }
      change += sum / (size * size * 3 * 255);
    }
    previous = frame;
  }
  return change / (steps - 1);
}

/** Each level's orbit change at `height`, as a ratio to the source's, summed over `views`. */
async function flicker(height: number, views: View[], keys: string[], steps = 8) {
  const { source } = current();
  let reference = 0;
  const changes = new Map(keys.map((key) => [key, 0]));
  for (const view of views) {
    reference += await orbitChange(source, view, height, steps);
    for (const key of keys) changes.set(key, must(changes.get(key), key) + (await orbitChange(built(key), view, height, steps)));
  }
  freeTargets();
  return Object.fromEntries([...changes].map(([key, change]) => [key, change / Math.max(reference, 1e-9)]));
}

// ------------------------------------------------------------------ cost

/** Largest side of the cost target. */
const COST_SIDE = 4096;

/**
 * GPU milliseconds of a frame drawing the scene into `target` (every pass and compute
 * dispatch, from timestamp queries), awaiting each frame's queries before the next:
 * the median of `repeats` runs of `frames` frames, and their spread
 * ((max - min) / median).
 */
async function frameMs(target: THREE.RenderTarget, view: THREE.Camera, frames: number, repeats: number): Promise<{ ms: number; spread: number }> {
  if (!renderer.hasFeature("timestamp-query")) throw new Error("bench.cost needs the GPU's timestamp-query feature");
  // Discard queries left by captures or shader warm-up before timing this target.
  await Promise.all([renderer.resolveTimestampsAsync("render"), renderer.resolveTimestampsAsync("compute")]);
  const run = async () => {
    let total = 0;
    for (let i = 0; i < frames; i++) {
      const computed = renderer.info.compute.calls;
      renderer.setRenderTarget(target);
      renderer.render(scene, view);
      renderer.setRenderTarget(null);
      const [passes, selection] = await Promise.all([
        renderer.resolveTimestampsAsync("render"),
        renderer.info.compute.calls > computed ? renderer.resolveTimestampsAsync("compute") : Promise.resolve(0),
      ]);
      total += (passes ?? 0) + (selection ?? 0);
    }
    return total / frames;
  };
  await run();
  const runs: number[] = [];
  for (let r = 0; r < repeats; r++) runs.push(await run());
  runs.sort((a, b) => a - b);
  const ms = at(runs, Math.floor(runs.length / 2));
  return { ms, spread: (at(runs, runs.length - 1) - at(runs, 0)) / ms };
}

/**
 * Microseconds per instance at `height` px for the source ("source") and each level: an
 * InstancedLod forced to the level, instances on a grid facing the camera, each
 * `height` px tall, the grid filling the target. The empty frame's time is subtracted.
 */
async function cost(height: number, keys: string[], frames = 20, repeats = 5) {
  const { levels, sphere } = current();
  const first = at(levels, 0);
  const cols = Math.max(1, Math.min(64, Math.floor(COST_SIDE / (1.15 * height))));
  const count = cols * cols;
  const side = Math.ceil(cols * 1.15 * height);
  const target = new THREE.RenderTarget(side, side, { samples: 4, colorSpace: THREE.SRGBColorSpace });
  const { center, radius } = sphere;
  const spacing = 2 * radius * 1.15;
  const view = new THREE.PerspectiveCamera(20, 1, 0.1, 1e6);
  const distance = (2 * radius * side) / (2 * Math.tan(THREE.MathUtils.degToRad(10)) * height);
  view.position.set(center.x, center.y, center.z + distance);
  view.lookAt(center);
  view.near = distance * 0.5;
  view.far = distance * 2;
  view.updateProjectionMatrix();
  scene.background = new THREE.Color(0x808080);
  // The empty frame is timed right before and after each level: the GPU's clocks drift.
  const timeEmpty = async () => (await frameMs(target, view, frames, repeats)).ms;
  let empty = await timeEmpty();
  const matrix = new THREE.Matrix4();
  const micros: Record<string, number> = {};
  const spread: Record<string, number> = {};
  for (const key of ["source", ...keys]) {
    const lod = key === "source" ? first.lod : built(key);
    const instanced = new InstancedLod(
      lod.levels.map((level) => level.object),
      count,
    );
    instanced.forceLevel = key === "source" ? 0 : 1;
    for (let i = 0; i < count; i++) {
      const x = ((i % cols) - (cols - 1) / 2) * spacing;
      const y = (Math.floor(i / cols) - (cols - 1) / 2) * spacing;
      instanced.setMatrixAt(i, matrix.makeRotationY(((i * 2654435761) % 1000) * 0.00628).setPosition(x, y, 0));
    }
    scene.add(instanced);
    const frame = await frameMs(target, view, frames, repeats);
    scene.remove(instanced);
    const after = await timeEmpty();
    micros[key] = ((frame.ms - (empty + after) / 2) / count) * 1000;
    spread[key] = frame.spread;
    empty = after;
  }
  scene.background = null;
  target.dispose();
  return { count, emptyMs: empty, micros, spread };
}

// ------------------------------------------------------------------ contact sheet

const SHEET_HEIGHTS = [24, 64, 192, 512];
const SHEET_TILE = 192;
const SHEET_HEADER = 20;

/** One image per level (rows) and sheet height (columns), magnified nearest-neighbour. */
class Sheet {
  readonly canvas = document.createElement("canvas");
  private rows: string[] = [];

  reset(keys: string[]): void {
    this.rows = ["source", ...keys];
    this.canvas.width = SHEET_TILE * SHEET_HEIGHTS.length + 150;
    this.canvas.height = SHEET_HEADER + SHEET_TILE * this.rows.length;
    const ctx = context2d(this.canvas);
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = "#111";
    ctx.font = "13px system-ui, sans-serif";
    this.rows.forEach((row, r) => ctx.fillText(row, 6, SHEET_HEADER + r * SHEET_TILE + SHEET_TILE / 2));
    SHEET_HEIGHTS.forEach((h, c) => ctx.fillText(`${h} px`, 150 + c * SHEET_TILE + 6, 14));
  }

  /** `pixels` (see capture) as row `row`'s image at `height`, over the sheet's grey. */
  draw(row: string, height: number, pixels: Uint8Array, size: number): void {
    const column = SHEET_HEIGHTS.indexOf(height);
    const r = this.rows.indexOf(row);
    if (column < 0 || r < 0) return;
    const ctx = context2d(this.canvas);
    ctx.imageSmoothingEnabled = size > SHEET_TILE;
    ctx.drawImage(glCanvas(pixels, size, size), 150 + column * SHEET_TILE, SHEET_HEADER + r * SHEET_TILE, SHEET_TILE, SHEET_TILE);
  }
}
const sheet = new Sheet();

const info = async () => ({ renderer: await gpuName(), sheetHeights: SHEET_HEIGHTS });

const bench = { prepare, measure, flicker, cost, sheet: () => sheet.canvas.toDataURL("image/png"), info };
declare global {
  interface Window {
    bench: typeof bench;
  }
}
window.bench = bench;

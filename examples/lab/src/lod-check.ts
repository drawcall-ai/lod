import * as THREE from "three/webgpu";
import { texture } from "three/tsl";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { bakeMesh, simplify, type BakeMeshOptions } from "@drawcall/lod";
import { errorOf } from "../../../packages/lod/src/levels.js";
import { readBytes } from "../../../packages/lod/src/renderer.js";
import { at } from "./must.js";
import { context2d, gpuName, gpuRenderer, png } from "./page.js";
import { subject } from "./subjects.js";

// Standalone page (lod.html): simplified and baked levels next to their source, with
// their render error against it. Driven by scripts/lod-check.ts through window.lodCheck.run().

const SUBJECTS = ["tree", "pine", "rock", "fence", "wall", "house"];
const RATIOS = [0.25, 0.05];
const views: Array<{ azimuth: number; elevation: number; zoom?: number }> = [
  { azimuth: 35, elevation: 12 },
  { azimuth: 160, elevation: 30 },
  { azimuth: 265, elevation: 65 },
  { azimuth: 20, elevation: 8, zoom: 5 }, // close-up: texture and normal detail
];
const TILE = 300;

// The sheets draw one tile at a time on the canvas, tone mapped as an app's frame is.
const renderer = await gpuRenderer(TILE);
renderer.toneMapping = THREE.NeutralToneMapping;
const pmrem = new THREE.PMREMGenerator(renderer);
const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const materialsOf = (mesh: THREE.Mesh): THREE.Material[] => [mesh.material].flat();

function triangles(object: THREE.Object3D) {
  let n = 0;
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const g: THREE.BufferGeometry = node.geometry;
    n += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
  });
  return n;
}

/** Width and height of a texture's image, whatever kind of image it is. */
function imageSize(image: unknown): { width: number; height: number } {
  if (
    typeof image === "object" &&
    image !== null &&
    "width" in image &&
    "height" in image &&
    typeof image.width === "number" &&
    typeof image.height === "number"
  )
    return { width: image.width, height: image.height };
  throw new Error(`lod-check: a texture image without a size: ${String(image)}`);
}

function textureBytes(object: THREE.Object3D) {
  const seen = new Set<THREE.Texture>();
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    for (const material of materialsOf(node)) for (const v of Object.values(material)) if (v instanceof THREE.Texture) seen.add(v);
  });
  let bytes = 0;
  for (const t of seen) {
    const { width, height } = imageSize(t.image);
    bytes += width * height * 4 * (t.generateMipmaps ? 4 / 3 : 1);
  }
  return Math.round(bytes);
}

function sceneFor(object: THREE.Object3D) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x5a6470);
  scene.environment = environment;
  scene.environmentIntensity = 0.6;
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 5, 2);
  scene.add(sun, object);
  return scene;
}

export type Mode = "lit" | "albedo" | "normal";

/** Sources load with MeshStandardMaterials; baked levels draw with node materials. */
type Standard = THREE.MeshStandardMaterial | THREE.MeshStandardNodeMaterial;
const isStandard = (material: THREE.Material): material is Standard =>
  material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshStandardNodeMaterial;

/** `material` drawing unlit base colour or view-space normals, for checking a bake. */
function inMode(material: THREE.Material, mode: Exclude<Mode, "lit">): THREE.Material {
  if (!isStandard(material)) throw new Error(`lod-check: ${mode} view of a ${material.type}`);
  const { side, alphaTest, map } = material;
  if (mode === "albedo") return new THREE.MeshBasicMaterial({ side, alphaTest, map, color: material.color, vertexColors: material.vertexColors });
  const normals = new THREE.MeshNormalNodeMaterial({
    side,
    normalMap: material.normalMap,
    normalMapType: material.normalMapType,
    normalScale: material.normalScale,
  });
  if (!map || alphaTest <= 0) return normals;
  // The cut-out still needs the colour map's alpha, read through the map's transform.
  const alpha = texture(map);
  alpha.updateMatrix = true;
  normals.maskNode = alpha.a.greaterThanEqual(alphaTest);
  return normals;
}

/** `object` as drawn in `mode`: itself when lit, else a copy with converted materials. */
function viewIn(object: THREE.Object3D, mode: Mode): THREE.Object3D {
  if (mode === "lit") return object;
  const copy = object.clone(true);
  copy.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const converted = materialsOf(node).map((material) => inMode(material, mode));
    node.material = Array.isArray(node.material) ? converted : at(converted, 0);
  });
  return copy;
}

const cameraPosition = (view: (typeof views)[number], sphere: THREE.Sphere, distance: number, into: THREE.Vector3) => {
  const az = THREE.MathUtils.degToRad(view.azimuth);
  const el = THREE.MathUtils.degToRad(view.elevation);
  return into
    .set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    .multiplyScalar(distance / (view.zoom ?? 1))
    .add(sphere.center);
};

async function sheet(name: string, columns: Array<{ label: string; object: THREE.Object3D }>, sphere: THREE.Sphere) {
  const w = columns.length * TILE;
  const h = views.length * TILE;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h + 22;
  const ctx = context2d(canvas);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, w, 22);
  const camera = new THREE.PerspectiveCamera(30, 1, sphere.radius * 0.05, sphere.radius * 20);
  const distance = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(15))) * 1.02;
  columns.forEach((column, c) => {
    const scene = sceneFor(column.object);
    views.forEach((view, r) => {
      cameraPosition(view, sphere, distance, camera.position);
      camera.lookAt(sphere.center);
      renderer.render(scene, camera);
      // Copied in the same task: the canvas holds the frame until it is presented.
      ctx.drawImage(renderer.domElement, c * TILE, 22 + r * TILE);
    });
    scene.remove(column.object);
  });
  ctx.fillStyle = "#eee";
  ctx.font = "14px system-ui, sans-serif";
  columns.forEach((column, c) => ctx.fillText(`${name} ${column.label}`, c * TILE + 6, 16));
  ctx.strokeStyle = "#111";
  for (let c = 1; c < columns.length; c++) ctx.strokeRect(c * TILE, 22, 0, h);
  return canvas.toDataURL("image/png");
}

/** Baked texture `texture` (rows bottom-up, i.e. v up) as a PNG data URL. */
function textureImage(texture: THREE.Texture | null): string {
  if (!(texture instanceof THREE.DataTexture)) throw new Error("lod-check: a baked map is not a DataTexture");
  const { width, height, data } = texture.image;
  if (!(data instanceof Uint8Array)) throw new Error("lod-check: a baked map is not 8-bit");
  return png(data, width, height);
}

/** One level's numbers; `error` is the one the package measured and switches by. */
export interface Measured {
  label: string;
  triangles: number;
  ms: number;
  textureBytes: number;
  error: number | undefined;
  colorError: number;
  coverageError: number;
}

async function run(only = SUBJECTS, ratios = RATIOS, modes: Mode[] = ["lit"]) {
  const results: Array<{ name: string; triangles: number; textureBytes: number; levels: Measured[] }> = [];
  const images: Record<string, string> = {};
  for (const name of only) {
    const { load, low } = subject(name);
    const source = await load();
    const sphere = new THREE.Box3().setFromObject(source).getBoundingSphere(new THREE.Sphere());
    const columns = [{ label: `source ${triangles(source)}`, object: source }];
    const levels: Measured[] = [];
    const measure = async (label: string, build: () => Promise<THREE.Object3D>) => {
      const t0 = performance.now();
      const level = await build();
      const ms = Math.round(performance.now() - t0);
      levels.push({ label, triangles: triangles(level), ms, textureBytes: textureBytes(level), error: errorOf(level), ...(await renderError(source, level, sphere)) });
      columns.push({ label: `${label} ${triangles(level)}`, object: level });
      return level;
    };
    for (const ratio of ratios) await measure(`simplified ${ratio}`, () => simplify(source, { ratio }));
    const variants: Array<{ label: string; options: BakeMeshOptions }> = ratios.map((ratio) => ({ label: String(ratio), options: { ratio } }));
    if (low) variants.push({ label: "low", options: { low: low() } });
    for (const [i, variant] of variants.entries()) {
      const baked = await measure(`baked ${variant.label}`, () => bakeMesh(source, variant.options));
      if (i !== 1 && variant.label !== "low") continue;
      if (!(baked instanceof THREE.Mesh) || !(baked.material instanceof THREE.MeshStandardNodeMaterial))
        throw new Error("lod-check: a baked level is not one standard mesh");
      const { map, normalMap, roughnessMap } = baked.material;
      const prefix = `${name}-baked-${variant.label}`;
      images[`${prefix}-color`] = textureImage(map);
      images[`${prefix}-normal`] = textureImage(normalMap);
      images[`${prefix}-orm`] = textureImage(roughnessMap);
    }
    for (const mode of modes)
      images[`${name}-${mode === "lit" ? "sheet" : mode}`] = await sheet(
        name,
        columns.map((c) => ({ label: c.label, object: viewIn(c.object, mode) })),
        sphere,
      );
    results.push({ name, triangles: triangles(source), textureBytes: textureBytes(source), levels });
  }
  return { renderer: await gpuName(), results, images };
}

const ERROR_SIZE = 256;
const errorTarget = new THREE.RenderTarget(ERROR_SIZE, ERROR_SIZE, { samples: 4 });

/** `object` alone from `camera` on a transparent background, as pixels. */
async function errorPixels(object: THREE.Object3D, camera: THREE.Camera): Promise<Uint8Array> {
  const scene = sceneFor(object);
  scene.background = null;
  renderer.setRenderTarget(errorTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  scene.remove(object);
  return readBytes(renderer, errorTarget, 0);
}

/**
 * How far `level` renders from `source`, over the sheet's whole-object views (not the
 * close-up) at 256 px: mean colour difference in 8-bit steps over the pixels both cover
 * (`colorError`), and the share of the pixels either covers that only one does
 * (`coverageError`).
 */
async function renderError(source: THREE.Object3D, level: THREE.Object3D, sphere: THREE.Sphere) {
  const camera = new THREE.PerspectiveCamera(30, 1, sphere.radius * 0.05, sphere.radius * 20);
  const distance = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(15))) * 1.02;
  let colour = 0;
  let mismatched = 0;
  let covered = 0;
  let both = 0;
  for (const view of views.filter((view) => view.zoom === undefined)) {
    cameraPosition(view, sphere, distance, camera.position);
    camera.lookAt(sphere.center);
    const a = await errorPixels(source, camera);
    const b = await errorPixels(level, camera);
    for (let i = 0; i < a.length; i += 4) {
      const inA = at(a, i + 3) > 127;
      const inB = at(b, i + 3) > 127;
      if (!inA && !inB) continue;
      covered++;
      if (inA !== inB) {
        mismatched++;
        continue;
      }
      both++;
      for (let c = 0; c < 3; c++) colour += Math.abs(at(a, i + c) - at(b, i + c)) / 3;
    }
  }
  return { colorError: Math.round((colour / both) * 100) / 100, coverageError: Math.round((mismatched / covered) * 1000) / 1000 };
}

declare global {
  interface Window {
    lodCheck: { run: typeof run };
  }
}
window.lodCheck = { run };

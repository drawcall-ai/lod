import { dispose } from "../../public/shared/dispose.ts";
import { Materials, surface } from "../../public/shared/materials.ts";
import type { GLTSLoader, GLTSScene } from "@drawcall/glts";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { BLOCK, HERO_VARIANT, layout, type Plant, plantTurn, ROWS, VARIANTS } from "../../public/corn/layout.ts";
import { houseInterior } from "../../public/house/interior.ts";
import { heights, houseParams, HOUSE_VARIANTS } from "../../public/house/params.ts";
import { facades } from "../../public/house/facades.ts";
import { ceiling } from "../../public/house/furnishings.ts";
import { foliageModel } from "@drawcall/lod";
import { MODEL_FOLIAGE } from "../world/trees.ts";
import { terrain } from "../render/ground/material.ts";

/** Something the viewer can show: the object, an optional close-up target, and the ground under it. */
export interface Item {
  object: THREE.Object3D;
  /** What the close view frames; the whole object when absent. */
  focus?: THREE.Box3;
  /** What the medium view frames; the whole object when absent. */
  overview?: THREE.Box3;
  ground: THREE.Material;
  /** Direction from the framed box toward the camera; front right and a little above when absent. */
  from?: THREE.Vector3;
  dispose(): void;
}

type Content = Omit<Item, "dispose">;
type Load = (path: string) => Promise<GLTSScene>;

const soil = (materials: Materials) => surface(materials, "farm_soil");

async function model(materials: Materials, id: string): Promise<Content> {
  const entry = materials.manifest.models[id];
  if (!entry) throw new Error(`model ${id} is not in the manifest`);
  const variant = entry.variants[0];
  if (!variant) throw new Error(`model ${id} has no variants`);
  const gltf = new GLTFLoader(materials.manager).setMeshoptDecoder(MeshoptDecoder);
  const { scene } = await gltf.loadAsync(`/assets/models/${id}/${variant}.glb`);
  scene.traverse((o) => {
    o.castShadow = o.receiveShadow = true;
  });
  foliageModel(scene, MODEL_FOLIAGE);
  return { object: scene, ground: terrain(materials) };
}

async function houseItem(materials: Materials, load: Load, variant: number, file: "house" | "house-low"): Promise<Content> {
  const p = houseParams(variant);
  const object = await load(`houses/${file}.glts?variant=${variant}`);
  // close-up: the front eave corner, where tiles, gutter, downpipe, fascia and a window meet
  const { eave } = heights(p);
  const focus = new THREE.Box3(
    new THREE.Vector3(p.width / 2 - 2.6, eave - 2.2, p.depth / 2 - 0.5),
    new THREE.Vector3(p.width / 2 + 0.5, eave + 1.2, p.depth / 2 + 1),
  );
  return { object, focus, ground: terrain(materials) };
}

/**
 * A house with its rooms behind see-through glass: close, the view through a ground-floor
 * front window into the room; medium, the whole house.
 */
async function interiorItem(materials: Materials, load: Load, variant: number): Promise<Content> {
  const p = houseParams(variant);
  const group = await load(`house/index.glts?variant=${variant}`);
  const front = facades(p)[0];
  const opening = front?.windows.find((w) => w.y < p.plinth + p.floorHeight);
  if (!front || !opening) throw new Error("the house has no ground-floor front window");
  const centre = new THREE.Vector3(opening.x, opening.y + opening.h / 2, 0).applyMatrix4(front.frame);
  const focus = new THREE.Box3(centre.clone().add(new THREE.Vector3(-1.2, -1, -2.5)), centre.clone().add(new THREE.Vector3(1.2, 1, 0.3)));
  return { object: group, focus, ground: terrain(materials) };
}

/**
 * The rooms of a three-storey house as a cutaway plan, seen from above: one copy per
 * storey side by side (ground floor on the left), each cut at 1.6 m above its floor,
 * ceilings and outer walls left out.
 */
function interiorPlanItem(materials: Materials, variant: number): Content {
  const p = houseParams(variant);
  const group = new THREE.Group();
  // each storey is moved down to y = 0, where the cut keeps 0.3 m below its floor to 1.6 m above
  const cut = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.6), new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.3)];
  for (let k = 0; k <= p.floors; k++) {
    const y0 = p.plinth + k * p.floorHeight;
    const storey = houseInterior(materials, p);
    storey.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
      if (o.material === ceiling(materials)) o.visible = false;
      o.material = o.material.clone();
      o.material.clippingPlanes = cut;
    });
    storey.position.x = k * (p.width + 2);
    storey.position.y = -y0;
    group.add(storey);
  }
  return { object: group, ground: terrain(materials), from: new THREE.Vector3(0, 1, 0.12) };
}

/** The hero ladybird and its actual plant, framed tight around the beetle. */
async function ladybirdItem(materials: Materials, load: Load): Promise<Content> {
  const [plant, ladybird] = await Promise.all([load(`corn/index.glts?variant=${HERO_VARIANT}&hero=1`), load(`ladybird/index.glts?variant=${HERO_VARIANT}`)]);
  const object = new THREE.Group().add(plant, ladybird);
  return { object, focus: new THREE.Box3().setFromObject(ladybird), ground: terrain(materials) };
}

/** A corn plant turned so its leaf plane faces the viewer, as the classic side-on silhouette. */
async function cornItem(materials: Materials, load: Load, variant: number): Promise<Content> {
  const plant = await load(`corn/index.glts?variant=${variant}`);
  plant.rotation.y = 0.5;
  plant.updateMatrixWorld();
  // close-up: the (first) ear and the leaves around it
  const ear = plant.getObjectByName("ear");
  if (!ear) throw new Error("corn plant has no ear");
  const focus = new THREE.Box3().setFromCenterAndSize(ear.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(0.45, 0.45, 0.45));
  return { object: plant, focus, ground: soil(materials) };
}

/**
 * Maize as the fields sow it (`layout`): `blocks` × `blocks` blocks of one design, the
 * plants that `include` accepts, each variant at full detail.
 */
async function cornRows(load: Load, blocks: number, include: (p: Plant) => boolean = () => true): Promise<THREE.Group> {
  const plants = await Promise.all(Array.from({ length: VARIANTS }, (_, variant) => load(`corn/index.glts?variant=${variant}`)));
  const field = new THREE.Group();
  const offset = ((blocks - 1) * BLOCK) / 2;
  for (let i = 0; i < blocks; i++)
    for (let j = 0; j < blocks; j++)
      for (const p of layout(0).filter(include)) {
        const plant = plants[p.variant]?.clone();
        if (!plant) throw new Error(`no corn variant ${p.variant}`);
        plant.position.set(p.x + i * BLOCK - offset, 0, p.z + j * BLOCK - offset);
        plantTurn(p, 0, plant.quaternion);
        field.add(plant);
      }
  return field;
}

/** About ten plants of a row, seen side-on, to judge density and silhouette. */
async function cornRowItem(materials: Materials, load: Load): Promise<Content> {
  const object = await cornRows(load, 1, (p) => p.z < -BLOCK / 2 + BLOCK / ROWS && p.x < -BLOCK / 2 + 1.8);
  return { object, ground: soil(materials) };
}

/** A block of field, framed from its edge across the rows (close) and from above (medium). */
async function cornFieldItem(materials: Materials, load: Load): Promise<Content> {
  const object = await cornRows(load, 2);
  const box = new THREE.Box3().setFromObject(object);
  const edge = new THREE.Box3(new THREE.Vector3(-1.5, 0, box.max.z - 2.5), new THREE.Vector3(1.5, 2.6, box.max.z));
  return { object, focus: edge, ground: soil(materials) };
}

/** The ground itself, with one house for scale: close is ~150 m across, medium ~2 km. */
async function terrainItem(materials: Materials, load: Load): Promise<Content> {
  const object = await load("house/index.glts?variant=0");
  const focus = new THREE.Box3(new THREE.Vector3(-60, 0, -60), new THREE.Vector3(60, 10, 60));
  const overview = new THREE.Box3(new THREE.Vector3(-500, 0, -500), new THREE.Vector3(500, 50, 500));
  return { object, focus, overview, ground: terrain(materials) };
}

type Build = (load: Load) => Promise<Content> | Content;

/** The house variant ?variant= asks the interior plan of. */
function planVariant(): number {
  const variant = new URLSearchParams(location.search).get("variant") ?? "3";
  if (!(/^\d+$/.test(variant) && Number(variant) < HOUSE_VARIANTS)) throw new Error(`variant must be a whole number below ${HOUSE_VARIANTS}, not ${variant}`);
  return Number(variant);
}

/** Every viewable item by name; procedural ones first, then the fetched models. */
function builds(materials: Materials): Map<string, Build> {
  const houses = Array.from({ length: HOUSE_VARIANTS }, (_, i): [string, Build] => [`house-${i}`, (load) => houseItem(materials, load, i, "house")]);
  const corn = Array.from({ length: VARIANTS }, (_, variant): [string, Build] => [`corn-${variant}`, (load) => cornItem(materials, load, variant)]);
  const models = Object.keys(materials.manifest.models).map((id): [string, Build] => [id, () => model(materials, id)]);
  return new Map<string, Build>([
    ...houses,
    ["house-low-0", (load) => houseItem(materials, load, 0, "house-low")],
    ["interior", (load) => interiorItem(materials, load, 1)],
    ["interior-plan", () => interiorPlanItem(materials, planVariant())],
    ...corn,
    ["corn-row", (load) => cornRowItem(materials, load)],
    ["corn-field", (load) => cornFieldItem(materials, load)],
    ["fence", async (load) => ({ object: await load("fence/index.glts?length=7.2"), ground: terrain(materials) })],
    [
      "sign",
      async (load) => ({
        object: await load("sign/index.glts?text=Maple%20St"),
        focus: new THREE.Box3(new THREE.Vector3(-0.5, 2.3, -0.3), new THREE.Vector3(0.5, 2.9, 0.3)),
        ground: terrain(materials),
      }),
    ],
    ["ladybird", (load) => ladybirdItem(materials, load)],
    ["terrain", (load) => terrainItem(materials, load)],
    ...models,
  ]);
}

export function itemNames(materials: Materials): string[] {
  return [...builds(materials).keys()];
}

async function content(materials: Materials, load: Load, name: string): Promise<Content> {
  const build = builds(materials).get(name);
  if (!build) throw new Error(`unknown item ${name}`);
  return build(load);
}

/** Item `name`, whose disposal frees what showing it made: its scripts' scenes, the rest of its object and its ground. */
export async function buildItem(scripts: GLTSLoader, name: string): Promise<Item> {
  const scenes = new Set<GLTSScene>();
  let disposed = false;
  let shown: Content | undefined;
  const free = () => {
    disposed = true;
    for (const scene of scenes) scene.dispose();
    scenes.clear();
    if (!shown) return;
    dispose(shown.object);
    // The ground's material and textures, freed as a mesh's are.
    dispose(new THREE.Mesh(undefined, shown.ground));
  };
  const load: Load = async (path) => {
    const scene = await scripts.loadAsync(`/${path}`);
    if (disposed) {
      scene.dispose();
      throw new Error("Viewer item was disposed while loading");
    }
    scenes.add(scene);
    return scene;
  };
  try {
    shown = await content(await Materials.load(scripts.manager, new URL("/assets/", location.href)), load, name);
    return { ...shown, dispose: free };
  } catch (error) {
    free();
    throw error;
  }
}

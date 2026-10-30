import type { Textures } from "../../public/content/textures.ts";
import { Library, assetUrl, surface } from "../../public/content/materials.ts";
import type { GLTSLoader, GLTSScene } from "@drawcall/glts";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { BLOCK, HERO_VARIANT, layout, type Plant, plantTurn, ROWS, VARIANTS } from "../../public/content/corn/layout.ts";
import { houseInterior } from "../../public/content/house/interior.ts";
import { heights, houseParams, HOUSE_VARIANTS } from "../../public/content/house/params.ts";
import { facades } from "../../public/content/house/facades.ts";
import type { HousePart } from "../../public/content/house/asset.ts";
import { ceiling } from "../../public/content/house/furnishings.ts";
import { foliageModel, MODEL_FOLIAGE } from "../../public/content/foliage.ts";
import { number } from "../../public/content/parameters.ts";
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

const soil = (library: Library) => surface(library, "farm_soil");

async function model(library: Library, id: string): Promise<Content> {
  const entry = library.manifest().models[id];
  if (!entry) throw new Error(`model ${id} is not in the manifest`);
  const variant = entry.variants[0];
  if (!variant) throw new Error(`model ${id} has no variants`);
  const gltf = new GLTFLoader(library.manager).setMeshoptDecoder(MeshoptDecoder);
  const { scene } = await gltf.loadAsync(assetUrl(library, `models/${id}/${variant}.glb`));
  scene.traverse((o) => {
    o.castShadow = o.receiveShadow = true;
  });
  foliageModel(scene, MODEL_FOLIAGE);
  library.own(scene);
  return { object: scene, ground: terrain(library) };
}

async function houseItem(library: Library, load: Load, variant: number, part: HousePart): Promise<Content> {
  const p = houseParams(variant);
  const object = await load(`houses/house.glts?variant=${variant}&part=${part}`);
  // close-up: the front eave corner, where tiles, gutter, downpipe, fascia and a window meet
  const { eave } = heights(p);
  const focus = new THREE.Box3(
    new THREE.Vector3(p.width / 2 - 2.6, eave - 2.2, p.depth / 2 - 0.5),
    new THREE.Vector3(p.width / 2 + 0.5, eave + 1.2, p.depth / 2 + 1),
  );
  return { object, focus, ground: terrain(library) };
}

/**
 * A house with its rooms behind see-through glass: close, the view through a ground-floor
 * front window into the room; medium, the whole house.
 */
async function interiorItem(library: Library, load: Load, variant: number): Promise<Content> {
  const p = houseParams(variant);
  const group = await load(`houses/house.glts?variant=${variant}&part=source`);
  const front = facades(p)[0];
  const opening = front?.windows.find((w) => w.y < p.plinth + p.floorHeight);
  if (!front || !opening) throw new Error("the house has no ground-floor front window");
  const centre = new THREE.Vector3(opening.x, opening.y + opening.h / 2, 0).applyMatrix4(front.frame);
  const focus = new THREE.Box3(centre.clone().add(new THREE.Vector3(-1.2, -1, -2.5)), centre.clone().add(new THREE.Vector3(1.2, 1, 0.3)));
  return { object: group, focus, ground: terrain(library) };
}

/**
 * The rooms of a three-storey house as a cutaway plan, seen from above: one copy per
 * storey side by side (ground floor on the left), each cut at 1.6 m above its floor,
 * ceilings and outer walls left out.
 */
function interiorPlanItem(library: Library, variant: number): Content {
  const p = houseParams(variant);
  const group = new THREE.Group();
  // each storey is moved down to y = 0, where the cut keeps 0.3 m below its floor to 1.6 m above
  const cut = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.6), new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.3)];
  for (let k = 0; k <= p.floors; k++) {
    const y0 = p.plinth + k * p.floorHeight;
    const storey = houseInterior(library, p);
    storey.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
      if (o.material === ceiling(library)) o.visible = false;
      o.material = o.material.clone();
      o.material.clippingPlanes = cut;
    });
    storey.position.x = k * (p.width + 2);
    storey.position.y = -y0;
    group.add(storey);
  }
  library.own(group);
  return { object: group, ground: terrain(library), from: new THREE.Vector3(0, 1, 0.12) };
}

/** The hero ladybird and its actual plant, framed tight around the beetle. */
async function ladybirdItem(library: Library, load: Load): Promise<Content> {
  const [plant, ladybird] = await Promise.all([load(`corn/plant.glts?variant=${HERO_VARIANT}&hero=1`), load(`corn/ladybird.glts?variant=${HERO_VARIANT}`)]);
  const object = new THREE.Group().add(plant, ladybird);
  return { object, focus: new THREE.Box3().setFromObject(ladybird), ground: terrain(library) };
}

/** A corn plant turned so its leaf plane faces the viewer, as the classic side-on silhouette. */
async function cornItem(library: Library, load: Load, variant: number): Promise<Content> {
  const plant = await load(`corn/plant.glts?variant=${variant}`);
  plant.rotation.y = 0.5;
  plant.updateMatrixWorld();
  // close-up: the (first) ear and the leaves around it
  const ear = plant.getObjectByName("ear");
  if (!ear) throw new Error("corn plant has no ear");
  const focus = new THREE.Box3().setFromCenterAndSize(ear.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(0.45, 0.45, 0.45));
  return { object: plant, focus, ground: soil(library) };
}

/**
 * Maize as the fields sow it (`layout`): `blocks` × `blocks` blocks of one design, the
 * plants that `keep` accepts, each variant at full detail.
 */
async function cornRows(load: Load, blocks: number, keep: (p: Plant) => boolean = () => true): Promise<THREE.Group> {
  const plants = await Promise.all(Array.from({ length: VARIANTS }, (_, variant) => load(`corn/plant.glts?variant=${variant}`)));
  const field = new THREE.Group();
  const offset = ((blocks - 1) * BLOCK) / 2;
  for (let i = 0; i < blocks; i++)
    for (let j = 0; j < blocks; j++)
      for (const p of layout(0).filter(keep)) {
        const plant = plants[p.variant]?.clone();
        if (!plant) throw new Error(`no corn variant ${p.variant}`);
        plant.position.set(p.x + i * BLOCK - offset, 0, p.z + j * BLOCK - offset);
        plantTurn(p, 0, plant.quaternion);
        field.add(plant);
      }
  return field;
}

/** About ten plants of a row, seen side-on, to judge density and silhouette. */
async function cornRowItem(library: Library, load: Load): Promise<Content> {
  const object = await cornRows(load, 1, (p) => p.z < -BLOCK / 2 + BLOCK / ROWS && p.x < -BLOCK / 2 + 1.8);
  return { object, ground: soil(library) };
}

/** A block of field, framed from its edge across the rows (close) and from above (medium). */
async function cornFieldItem(library: Library, load: Load): Promise<Content> {
  const object = await cornRows(load, 2);
  const box = new THREE.Box3().setFromObject(object);
  const edge = new THREE.Box3(new THREE.Vector3(-1.5, 0, box.max.z - 2.5), new THREE.Vector3(1.5, 2.6, box.max.z));
  return { object, focus: edge, ground: soil(library) };
}

/** The ground itself, with one house for scale: close is ~150 m across, medium ~2 km. */
async function terrainItem(library: Library, load: Load): Promise<Content> {
  const object = await load("houses/house.glts?variant=0&part=source");
  const focus = new THREE.Box3(new THREE.Vector3(-60, 0, -60), new THREE.Vector3(60, 10, 60));
  const overview = new THREE.Box3(new THREE.Vector3(-500, 0, -500), new THREE.Vector3(500, 50, 500));
  return { object, focus, overview, ground: terrain(library) };
}

type Build = (load: Load) => Promise<Content> | Content;

/** Every viewable item by name; procedural ones first, then the fetched models. */
function builds(library: Library): Map<string, Build> {
  const houses = Array.from({ length: HOUSE_VARIANTS }, (_, i): [string, Build] => [`house-${i}`, (load) => houseItem(library, load, i, "source")]);
  const corn = Array.from({ length: VARIANTS }, (_, variant): [string, Build] => [`corn-${variant}`, (load) => cornItem(library, load, variant)]);
  const models = Object.keys(library.manifest().models).map((id): [string, Build] => [id, () => model(library, id)]);
  return new Map<string, Build>([
    ...houses,
    ["house-low-0", (load) => houseItem(library, load, 0, "low")],
    ["interior", (load) => interiorItem(library, load, 1)],
    ["interior-plan", () => interiorPlanItem(library, number(new URLSearchParams(location.search), "variant", 3, 0, HOUSE_VARIANTS - 1, true))],
    ...corn,
    ["corn-row", (load) => cornRowItem(library, load)],
    ["corn-field", (load) => cornFieldItem(library, load)],
    ["fence", async (load) => ({ object: await load("props/fence.glts?length=7.2"), ground: terrain(library) })],
    [
      "sign",
      async (load) => ({
        object: await load("props/sign.glts?text=Maple%20St"),
        focus: new THREE.Box3(new THREE.Vector3(-0.5, 2.3, -0.3), new THREE.Vector3(0.5, 2.9, 0.3)),
        ground: terrain(library),
      }),
    ],
    ["ladybird", (load) => ladybirdItem(library, load)],
    ["terrain", (load) => terrainItem(library, load)],
    ...models,
  ]);
}

export function itemNames(library: Library): string[] {
  return [...builds(library).keys()];
}

async function content(library: Library, load: Load, name: string): Promise<Content> {
  const build = builds(library).get(name);
  if (!build) throw new Error(`unknown item ${name}`);
  return build(load);
}

/** Each inspection owns its script executions and helper resources until replaced. */
export async function buildItem(scripts: GLTSLoader, base: string, name: string, textures: Textures): Promise<Item> {
  const library = new Library(scripts.manager, base, textures);
  const scenes = new Set<GLTSScene>();
  let disposed = false;
  const dispose = () => {
    disposed = true;
    for (const scene of scenes) scene.dispose();
    scenes.clear();
    library.dispose();
  };
  const load: Load = async (path) => {
    const scene = await scripts.loadAsync(new URL(`../${path}`, base));
    if (disposed) {
      scene.dispose();
      throw new Error("Viewer item was disposed while loading");
    }
    scenes.add(scene);
    return scene;
  };
  try {
    await library.load();
    return { ...(await content(library, load, name)), dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

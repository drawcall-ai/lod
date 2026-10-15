import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { cornPlant, leaf, leafMaterial } from "../content/corn/index.ts";
import { BLOCK, layout, type Plant, plantTurn, VARIANTS } from "../world/corn/field.ts";
import { picketFence } from "../content/fence.ts";
import { heights, house, houseInterior, houseParams } from "../content/house/index.ts";
import { facades } from "../content/house/facades.ts";
import { ceiling } from "../content/house/furnishings.ts";
import { ladybird } from "../content/ladybird.ts";
import { foliageModel } from "../content/foliage.ts";
import { assetUrl, manifest, surface } from "../content/materials.ts";
import { streetSign } from "../content/sign.ts";
import { terrain } from "../content/terrain.ts";

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
}

const soil = () => surface("farm_soil");

const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

async function model(id: string): Promise<Item> {
  const entry = manifest().models[id];
  if (!entry) throw new Error(`model ${id} is not in the manifest`);
  const { scene } = await gltf.loadAsync(assetUrl(entry.file));
  scene.traverse((o) => {
    o.castShadow = o.receiveShadow = true;
  });
  foliageModel(scene, { translucency: 0.6 });
  return { object: scene, ground: terrain() };
}

function houseItem(seed: number, level: "detail" | "low"): Item {
  const p = houseParams(seed);
  const built = house(p);
  // close-up: the front eave corner, where tiles, gutter, downpipe, fascia and a window meet
  const { eave } = heights(p);
  const focus = new THREE.Box3(
    new THREE.Vector3(p.width / 2 - 2.6, eave - 2.2, p.depth / 2 - 0.5),
    new THREE.Vector3(p.width / 2 + 0.5, eave + 1.2, p.depth / 2 + 1),
  );
  built.low.castShadow = built.low.receiveShadow = true;
  return { object: level === "detail" ? built.detail : built.low, focus, ground: terrain() };
}

/**
 * A house with its rooms behind see-through glass: close, the view through a ground-floor
 * front window into the room; medium, the whole house.
 */
function interiorItem(seed: number): Item {
  const p = houseParams(seed);
  const group = new THREE.Group();
  group.add(house(p).detail, houseInterior(p));
  const front = facades(p)[0];
  const window = front?.windows.find((w) => w.y < p.plinth + p.floorHeight);
  if (!front || !window) throw new Error("the house has no ground-floor front window");
  const centre = new THREE.Vector3(window.x, window.y + window.h / 2, 0).applyMatrix4(front.frame);
  const focus = new THREE.Box3(centre.clone().add(new THREE.Vector3(-1.2, -1, -2.5)), centre.clone().add(new THREE.Vector3(1.2, 1, 0.3)));
  return { object: group, focus, ground: terrain() };
}

/**
 * The rooms of a three-storey house as a cutaway plan, seen from above: one copy per
 * storey side by side (ground floor on the left), each cut at 1.6 m above its floor,
 * ceilings and outer walls left out.
 */
function interiorPlanItem(seed: number): Item {
  const p = houseParams(seed);
  const group = new THREE.Group();
  // each storey is moved down to y = 0, where the cut keeps 0.3 m below its floor to 1.6 m above
  const cut = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.6), new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.3)];
  for (let k = 0; k <= p.floors; k++) {
    const y0 = p.plinth + k * p.floorHeight;
    const storey = houseInterior(p);
    storey.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
      if (o.material === ceiling()) o.visible = false;
      o.material = o.material.clone();
      o.material.clippingPlanes = cut;
    });
    storey.position.x = k * (p.width + 2);
    storey.position.y = -y0;
    group.add(storey);
  }
  return { object: group, ground: terrain(), from: new THREE.Vector3(0, 1, 0.12) };
}

/** The ladybird on a level stretch of corn leaf, framed tight around the beetle. */
function ladybirdItem(): Item {
  const group = new THREE.Group();
  const blade = new THREE.Mesh(
    leaf(new THREE.Vector3(0, 0.05, -0.2), Math.PI / 2, {
      length: 0.4,
      width: 0.09,
      // rising slightly, then arching over: the middle, where the beetle sits, is level
      rise: Math.PI / 2 - 0.12,
      droop: 0.24,
      twist: 0,
      fold: 0.03,
      ripple: 0,
      color: new THREE.Color("#ffffff"),
      seed: 3,
      segments: [160, 48],
    }),
    leafMaterial(),
  );
  blade.castShadow = blade.receiveShadow = true;
  const beetle = ladybird();
  // on one half of the blade, beside the midrib, standing on its surface
  const hit = new THREE.Raycaster(new THREE.Vector3(0.012, 1, 0), new THREE.Vector3(0, -1, 0)).intersectObject(blade)[0];
  if (!hit) throw new Error("ladybird is not over the leaf");
  beetle.position.copy(hit.point);
  // turned three-quarter toward the close view, so head, pronotum and spots all show
  beetle.rotation.y = 0.9;
  group.add(blade, beetle);
  return { object: group, focus: new THREE.Box3().setFromObject(beetle), ground: terrain() };
}

/** A corn plant turned so its leaf plane faces the viewer, as the classic side-on silhouette. */
function cornItem(seed: number): Item {
  const plant = cornPlant(seed);
  plant.rotation.y = 0.5;
  plant.updateMatrixWorld();
  // close-up: the (first) ear and the leaves around it
  const ear = plant.getObjectByName("ear");
  if (!ear) throw new Error("corn plant has no ear");
  const focus = new THREE.Box3().setFromCenterAndSize(ear.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(0.45, 0.45, 0.45));
  return { object: plant, focus, ground: soil() };
}

/**
 * Maize as the fields sow it (`layout`): `blocks` × `blocks` blocks of one design, the
 * plants that `keep` accepts, each variant at full detail.
 */
function cornRows(blocks: number, keep: (p: Plant) => boolean = () => true): THREE.Group {
  const plants = Array.from({ length: VARIANTS }, (_, v) => cornPlant(v + 1));
  const field = new THREE.Group();
  const offset = ((blocks - 1) * BLOCK) / 2;
  for (let i = 0; i < blocks; i++)
    for (let j = 0; j < blocks; j++)
      for (const p of layout(11).filter(keep)) {
        const plant = plants[p.variant]?.clone();
        if (!plant) throw new Error(`no corn variant ${p.variant}`);
        plant.position.set(p.x + i * BLOCK - offset, 0, p.z + j * BLOCK - offset);
        plantTurn(p, 0, plant.quaternion);
        field.add(plant);
      }
  return field;
}

/** About ten plants of a row, seen side-on, to judge density and silhouette. */
function cornRowItem(): Item {
  const object = cornRows(1, (p) => p.z < -BLOCK / 2 + 0.75 && p.x < -BLOCK / 2 + 1.8);
  return { object, ground: soil() };
}

/** A block of field, framed from its edge across the rows (close) and from above (medium). */
function cornFieldItem(): Item {
  const object = cornRows(2);
  const box = new THREE.Box3().setFromObject(object);
  const edge = new THREE.Box3(new THREE.Vector3(-1.5, 0, box.max.z - 2.5), new THREE.Vector3(1.5, 2.6, box.max.z));
  return { object, focus: edge, ground: soil() };
}

/** The ground itself, with one house for scale: close is ~150 m across, medium ~2 km. */
function terrainItem(): Item {
  const object = house(houseParams(1)).detail;
  const focus = new THREE.Box3(new THREE.Vector3(-60, 0, -60), new THREE.Vector3(60, 10, 60));
  const overview = new THREE.Box3(new THREE.Vector3(-500, 0, -500), new THREE.Vector3(500, 50, 500));
  return { object, focus, overview, ground: terrain() };
}

/** Every viewable item by name; procedural ones first, then the fetched models. */
export function itemNames(): string[] {
  const houses = [1, 2, 3, 4, 5, 6].map((s) => `house-${s}`);
  return [
    ...houses,
    "house-low-1",
    "interior",
    "interior-plan",
    "corn-1",
    "corn-2",
    "corn-3",
    "corn-row",
    "corn-field",
    "fence",
    "sign",
    "ladybird",
    "terrain",
    ...Object.keys(manifest().models),
  ];
}

export async function buildItem(name: string): Promise<Item> {
  const house = name.match(/^house-(low-)?(\d+)$/);
  if (house) return houseItem(Number(house[2]), house[1] ? "low" : "detail");
  if (name === "interior") return interiorItem(2);
  if (name === "interior-plan") return interiorPlanItem(Number(new URLSearchParams(location.search).get("seed") ?? 4));
  if (name === "corn-row") return cornRowItem();
  if (name === "corn-field") return cornFieldItem();
  const corn = name.match(/^corn-(\d+)$/);
  if (corn) return cornItem(Number(corn[1]));
  if (name === "fence") return { object: picketFence(7.2), ground: terrain() };
  if (name === "sign")
    return { object: streetSign("Maple St"), focus: new THREE.Box3(new THREE.Vector3(-0.5, 2.3, -0.3), new THREE.Vector3(0.5, 2.9, 0.3)), ground: terrain() };
  if (name === "ladybird") return ladybirdItem();
  if (name === "terrain") return terrainItem();
  if (manifest().models[name]) return model(name);
  throw new Error(`unknown item ${name}`);
}

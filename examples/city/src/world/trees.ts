import type { LodLevel, Wind } from "@drawcall/lod";
import { InstancedLod } from "@drawcall/lod";
import * as THREE from "three/webgpu";
import { Random } from "../../public/content/random.ts";
import { loader } from "../loading.ts";
import { foliageLevels, foliageModel, MODEL_FOLIAGE } from "../../public/content/foliage.ts";
import { SPECIES, treeLadder, type Species } from "../../public/content/ladders.ts";
import { plantInstance, stands } from "./ground-records.ts";
import { Use } from "./land.ts";
import { spread } from "./place.ts";
import { sourceBox } from "./bounds.ts";
import { inForest, type Plan } from "./plan.ts";

/** Edge of a forest tile (m), and how far from the camera forests are held: all of the world from the tour's height. */
const TILE = 96;
const RADIUS = 6000;
/** Trees per square metre on a forest's grid. */
const DENSITY = 1 / 5.5 ** 2;
/** How far inside a forest's edge its shrubs and saplings thicken (m). */
const EDGE = 14;

/** What a forest grows, with the share of its spots each takes and how large. */
type Mix = { id: string; share: number; scale: [number, number] }[];
const INSIDE: Mix = [
  { id: "tree_small_02", share: 0.62, scale: [2.2, 3.2] },
  { id: "searsia_lucida", share: 0.18, scale: [1.8, 2.6] },
  { id: "shrub_02", share: 0.1, scale: [1, 1.6] },
  { id: "pine_sapling_small", share: 0.1, scale: [2.4, 3.4] },
];
const BORDER: Mix = [
  { id: "shrub_02", share: 0.45, scale: [0.9, 1.6] },
  { id: "pine_sapling_small", share: 0.25, scale: [1.6, 3.4] },
  { id: "searsia_lucida", share: 0.18, scale: [1.8, 2.6] },
  { id: "tree_small_02", share: 0.12, scale: [2.2, 3.2] },
];

/** The forests, streamed on the GPU (`Stream.update` them before each frame), and the trees the plan placed elsewhere. */
export async function trees(plan: Plan, renderer: THREE.WebGPURenderer, wind?: Wind): Promise<THREE.Group> {
  const root = new THREE.Group();
  root.name = "trees";
  const sway = (crowd: InstancedLod) => {
    const box = sourceBox(crowd.levels);
    wind?.apply(crowd, { amplitude: (box.max.y - box.min.y) * 0.025 });
    return crowd;
  };
  const grown = new Set([...INSIDE, ...BORDER].map(({ id }) => id));
  const planted = SPECIES.filter(({ id }) => grown.has(id) || plan.models.get(id)?.length);
  const loaded = new Map(await Promise.all(planted.map(async (species) => [species.id, await speciesModels(species)] as const)));
  const modelsOf = (id: string) => {
    const models = loaded.get(id);
    if (!models) throw new Error(`No species ${id}`);
    return models;
  };

  for (const [id, models] of loaded) {
    const spots = plan.models.get(id);
    if (spots?.length) root.add(...spread(id, models, spots, foliageTint).map(sway));
  }

  const stand = stands(plan, renderer);
  const forest = (x: number, z: number) => plan.land.at(x, z) === Use.Forest;
  const inside = (x: number, z: number) => plan.forests.some((f) => inForest(f, x, z, -EDGE));
  const mixes: [string, Mix, (x: number, z: number) => boolean][] = [
    ["forest", INSIDE, (x, z) => forest(x, z) && inside(x, z)],
    ["forest edge", BORDER, (x, z) => forest(x, z) && !inside(x, z)],
  ];
  for (const [name, mix, grows] of mixes) {
    root.add(
      stand({ name, tile: TILE, density: DENSITY, radius: RADIUS, grows }, (records) => {
        const crowds: InstancedLod[] = [];
        let from = 0;
        for (const { id, share, scale } of mix)
          modelsOf(id).forEach((levels, variant, models) => {
            const part = share / models.length;
            const crowd = new InstancedLod(levels, { gpuRecords: records(plantInstance(from, from + part, scale, true), scale, part) });
            crowd.name = `${name} ${id} ${variant}`;
            crowds.push(sway(crowd));
            from += part;
          });
        return crowds;
      }),
    );
  }
  return root;
}

function speciesModels(species: Species): Promise<LodLevel[][]> {
  return Promise.all(
    species.variants.map((variant) =>
      loader.loadAsync({
        ...treeLadder(species, variant),
        onLevel: (object) => {
          object.traverse((node) => (node.castShadow = node.receiveShadow = true));
          foliageModel(object, MODEL_FOLIAGE);
          foliageLevels(object, MODEL_FOLIAGE);
        },
      }),
    ),
  );
}

/** Every tree a little different: lighter or darker, yellower or bluer green. */
function foliageTint(seed: number, color: THREE.Color): THREE.Color {
  const r = new Random(seed);
  return color
    .setRGB(1, 1, 1)
    .multiplyScalar(r.range(0.82, 1.1))
    .lerp(r.chance(0.5) ? YELLOWER : BLUER, r.range(0, 0.35));
}

const YELLOWER = new THREE.Color(1.1, 1.05, 0.7);
const BLUER = new THREE.Color(0.85, 0.95, 1.0);

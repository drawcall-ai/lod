import { CachedLodLoader, foliageLevels, foliageModel, type FoliageOptions, type InstancedLod, type LodGpu, type LodLevel, type Wind } from "@drawcall/lod";
import * as THREE from "three/webgpu";
import seedrandom from "seedrandom";
import { arriving, manager } from "../loading.ts";
import { planter, type Planting } from "./planting.ts";
import { Use } from "./land.ts";
import { spread } from "./place.ts";
import { sourceBox } from "./bounds.ts";
import { inForest, type Plan } from "./plan.ts";

/** The foliage shading of the fetched plant models' leaves. */
export const MODEL_FOLIAGE: FoliageOptions = { translucency: 0.6 };

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

/** The forests, planted on the GPU in the tiles near the camera (`update` them before each frame), and the trees the plan placed elsewhere. */
export async function trees(plan: Plan, gpu: LodGpu, wind?: Wind): Promise<THREE.Group> {
  const root = new THREE.Group();
  root.name = "trees";
  const sway = (lod: InstancedLod) => {
    const box = sourceBox(lod.levels);
    wind?.apply(lod, { amplitude: (box.max.y - box.min.y) * 0.025 });
    return lod;
  };
  const grown = new Set([...INSIDE, ...BORDER].map(({ id }) => id));
  const planted = Object.entries(SPECIES).filter(([id]) => grown.has(id) || plan.models.get(id)?.length);
  const loaded = new Map(await Promise.all(planted.map(async ([id, variants]) => [id, await Promise.all(variants.map((load) => load()))] as const)));
  const modelsOf = (id: string) => {
    const models = loaded.get(id);
    if (!models) throw new Error(`No species ${id}`);
    return models;
  };

  for (const [id, models] of loaded) {
    const spots = plan.models.get(id);
    if (spots?.length) root.add(...spread(gpu, id, models, spots, foliageTint).map(sway));
  }

  const plant = planter(plan, gpu);
  const forest = (x: number, z: number) => plan.land.at(x, z) === Use.Forest;
  const inside = (x: number, z: number) => plan.forests.some((f) => inForest(f, x, z, -EDGE));
  const mixes: [string, Mix, (x: number, z: number) => boolean][] = [
    ["forest", INSIDE, (x, z) => forest(x, z) && inside(x, z)],
    ["forest edge", BORDER, (x, z) => forest(x, z) && !inside(x, z)],
  ];
  for (const [name, mix, grows] of mixes) {
    const plantings: Planting[] = [];
    let from = 0;
    for (const { id, share, scale } of mix)
      modelsOf(id).forEach((levels, variant, models) => {
        const to = from + share / models.length;
        plantings.push({ name: `${name} ${id} ${variant}`, levels, from, to, scale, tinted: true });
        from = to;
      });
    const planted = plant({ name, tile: TILE, density: DENSITY, radius: RADIUS, grows }, plantings);
    planted.lods.forEach(sway);
    root.add(planted);
  }
  return root;
}

const options = arriving((object) => {
  object.traverse((node) => (node.castShadow = node.receiveShadow = true));
  foliageModel(object, MODEL_FOLIAGE);
  foliageLevels(object, MODEL_FOLIAGE);
});

/**
 * Trees and shrubs (Poly Haven scans, every leaf a card), by species, a load per variant: the source model, a detailed
 * hemispherical impostor (they always stand upright), a 64 px impostor from 60 px, then, for small plants, an empty
 * level that culls them below 2 px. No simplified level: decimated leaf cards look ragged, while the impostor keeps
 * every leaf's look. The switch heights are set for the frame budget; the broadleaf scan keeps its full leaf geometry
 * nearby and a larger impostor.
 */
const SPECIES: Record<string, (() => Promise<LodLevel[]>)[]> = {
  tree_small_02: [
    () =>
      new CachedLodLoader(manager, options).loadAsync({
        url: "/assets/models/tree_small_02/tree_small_02_LOD0.glb",
        levels: [
          { type: "impostor", layout: "hemi", maxPixels: 900, resolution: 256, frames: 10 },
          { type: "impostor", layout: "hemi", maxPixels: 60, resolution: 64, frames: 8 },
        ],
      }),
  ],
  searsia_lucida: [
    () =>
      new CachedLodLoader(manager, options).loadAsync({
        url: "/assets/models/searsia_lucida/searsia_lucida_a_LOD0.glb",
        levels: [
          { type: "impostor", layout: "hemi", maxPixels: 300 },
          { type: "impostor", layout: "hemi", maxPixels: 60, resolution: 64, frames: 8 },
        ],
      }),
    () =>
      new CachedLodLoader(manager, options).loadAsync({
        url: "/assets/models/searsia_lucida/searsia_lucida_e_LOD0.glb",
        levels: [
          { type: "impostor", layout: "hemi", maxPixels: 300 },
          { type: "impostor", layout: "hemi", maxPixels: 60, resolution: 64, frames: 8 },
        ],
      }),
  ],
  pine_sapling_small: [
    () =>
      new CachedLodLoader(manager, options).loadAsync({
        url: "/assets/models/pine_sapling_small/pine_sapling_small_a.glb",
        levels: [
          { type: "impostor", layout: "hemi", maxPixels: 300 },
          { type: "impostor", layout: "hemi", maxPixels: 60, resolution: 64, frames: 8 },
        ],
      }),
    () =>
      new CachedLodLoader(manager, options).loadAsync({
        url: "/assets/models/pine_sapling_small/pine_sapling_small_b.glb",
        levels: [
          { type: "impostor", layout: "hemi", maxPixels: 300 },
          { type: "impostor", layout: "hemi", maxPixels: 60, resolution: 64, frames: 8 },
        ],
      }),
  ],
  shrub_02: [
    () =>
      new CachedLodLoader(manager, options).loadAsync({
        url: "/assets/models/shrub_02/shrub_02_a.glb",
        levels: [
          { type: "impostor", layout: "hemi", maxPixels: 300 },
          { type: "impostor", layout: "hemi", maxPixels: 60, resolution: 64, frames: 8 },
          { type: "empty", maxPixels: 2 },
        ],
      }),
    () =>
      new CachedLodLoader(manager, options).loadAsync({
        url: "/assets/models/shrub_02/shrub_02_c.glb",
        levels: [
          { type: "impostor", layout: "hemi", maxPixels: 300 },
          { type: "impostor", layout: "hemi", maxPixels: 60, resolution: 64, frames: 8 },
          { type: "empty", maxPixels: 2 },
        ],
      }),
  ],
  // garden perennials and vegetables
  fern_02: [
    () =>
      new CachedLodLoader(manager, options).loadAsync({
        url: "/assets/models/fern_02/fern_02_a.glb",
        levels: [
          { type: "impostor", layout: "hemi", maxPixels: 200 },
          { type: "impostor", layout: "hemi", maxPixels: 60, resolution: 64, frames: 8 },
          { type: "empty", maxPixels: 2 },
        ],
      }),
    () =>
      new CachedLodLoader(manager, options).loadAsync({
        url: "/assets/models/fern_02/fern_02_b.glb",
        levels: [
          { type: "impostor", layout: "hemi", maxPixels: 200 },
          { type: "impostor", layout: "hemi", maxPixels: 60, resolution: 64, frames: 8 },
          { type: "empty", maxPixels: 2 },
        ],
      }),
  ],
  nettle_plant: [
    () =>
      new CachedLodLoader(manager, options).loadAsync({
        url: "/assets/models/nettle_plant/nettle_plant_medium_a_LOD0.glb",
        levels: [
          { type: "impostor", layout: "hemi", maxPixels: 200 },
          { type: "impostor", layout: "hemi", maxPixels: 60, resolution: 64, frames: 8 },
          { type: "empty", maxPixels: 2 },
        ],
      }),
    () =>
      new CachedLodLoader(manager, options).loadAsync({
        url: "/assets/models/nettle_plant/nettle_plant_tall_a_LOD0.glb",
        levels: [
          { type: "impostor", layout: "hemi", maxPixels: 200 },
          { type: "impostor", layout: "hemi", maxPixels: 60, resolution: 64, frames: 8 },
          { type: "empty", maxPixels: 2 },
        ],
      }),
  ],
};

/** Every tree a little different: lighter or darker, yellower or bluer green. */
function foliageTint(seed: number, color: THREE.Color): THREE.Color {
  const r = seedrandom(String(seed));
  return color
    .setRGB(1, 1, 1)
    .multiplyScalar(0.82 + 0.28 * r())
    .lerp(r() < 0.5 ? YELLOWER : BLUER, 0.35 * r());
}

const YELLOWER = new THREE.Color(1.1, 1.05, 0.7);
const BLUER = new THREE.Color(0.85, 0.95, 1.0);

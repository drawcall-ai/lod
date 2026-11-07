import type { LevelRequest } from "@drawcall/lod";
import { HERO_VARIANT, VARIANTS as CORN_VARIANTS } from "./corn/layout.ts";
import { HOUSE_VARIANTS } from "./house/params.ts";

/**
 * A ladder as the city requests it from `LodLoader`. The app adds its `onLevel` effects, which change nothing cached;
 * public/precompute.glts builds every ladder in `LADDERS` into the deployed cache, so the app finds each one it requests.
 */
export interface Ladder {
  url: string;
  levels: LevelRequest[];
}

interface Species {
  id: string;
  variants: string[];
  maxPixels: number;
  resolution?: number;
  frames?: number;
  cull?: number;
}

/**
 * Trees and shrubs (Poly Haven scans, every leaf a card): per species and variant one
 * InstancedLod whose ladder is the source model, a detailed hemispherical impostor (they
 * always stand upright) from the species' maxPixels, a 64 px impostor from 60 px, then,
 * for small plants, an empty level that culls them below `cull` px. No simplified level:
 * decimated leaf cards look ragged, while the impostor keeps every leaf's look. The
 * switch heights are set for the frame budget; the broadleaf scan keeps its full leaf
 * geometry nearby and a larger impostor.
 */
export const SPECIES: Species[] = [
  { id: "tree_small_02", variants: ["tree_small_02_LOD0"], maxPixels: 900, resolution: 256, frames: 10 },
  { id: "searsia_lucida", variants: ["searsia_lucida_a_LOD0", "searsia_lucida_e_LOD0"], maxPixels: 300 },
  { id: "pine_sapling_small", variants: ["pine_sapling_small_a", "pine_sapling_small_b"], maxPixels: 300 },
  { id: "shrub_02", variants: ["shrub_02_a", "shrub_02_c"], maxPixels: 300, cull: 2 },
  // garden perennials and vegetables
  { id: "fern_02", variants: ["fern_02_a", "fern_02_b"], maxPixels: 200, cull: 2 },
  { id: "nettle_plant", variants: ["nettle_plant_medium_a_LOD0", "nettle_plant_tall_a_LOD0"], maxPixels: 200, cull: 2 },
];

export function treeLadder({ id, maxPixels, resolution, frames, cull }: Species, variant: string): Ladder {
  const levels: LevelRequest[] = [
    { type: "impostor", layout: "hemi", maxPixels, resolution, frames },
    { type: "impostor", layout: "hemi", maxPixels: 60, resolution: 64, frames: 8 },
  ];
  if (cull !== undefined) levels.push({ type: "empty", maxPixels: cull });
  return { url: `/assets/models/${id}/${variant}.glb`, levels };
}

/**
 * Street furniture and cars keep their meshes nearby and use a small impostor in the
 * distance. Its self-contained textures let the overview defer original model fetches.
 * Below a few pixels (more for thin lamps, which vanish into a line sooner) they disappear.
 */
export const PROPS = [
  { id: "street_lamp_01", ratio: 0.03, cull: 8 },
  { id: "painted_wooden_bench", ratio: 0.5, cull: 3 },
  { id: "metal_trash_can", ratio: 0.25, cull: 3 },
  { id: "fire_hydrant", ratio: 0.1, cull: 3 },
  { id: "utility_box_01", ratio: 0.5, cull: 3 },
  { id: "covered_car", ratio: 0.12, cull: 4 },
  { id: "wooden_crate_01", ratio: 0.5, cull: 3 },
  { id: "planter_box_01", ratio: 0.5, cull: 3 },
];

export const propLadder = ({ id, ratio, cull }: (typeof PROPS)[number]): Ladder => ({
  url: `/assets/models/${id}/${id}.glb`,
  levels: [
    { type: "simplify", ratio },
    { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 60 },
    { type: "empty", maxPixels: cull },
  ],
});

export const FENCE: Ladder = {
  url: "/props/fence.glts?length=2.4",
  levels: [
    { type: "simplify", ratio: 0.3 },
    { type: "impostor", layout: "hemi", maxPixels: 40, resolution: 64 },
    { type: "empty", maxPixels: 10 },
  ],
};

export const SIGN_NAMES = ["Maple St", "Church Rd", "Mill Lane", "Oak Ave", "High St", "Elm St"];

export const signLadder = (name: string): Ladder => ({
  url: `/props/sign.glts?${new URLSearchParams({ text: name })}`,
  levels: [
    { type: "simplify", ratio: 0.5 },
    { type: "impostor", layout: "hemi", maxPixels: 20, resolution: 64 },
    { type: "empty", maxPixels: 4 },
  ],
});

export const GARDEN_ITEMS = ["letterbox", "patio set", "shed", "greenhouse", "washing line", "swing"] as const;
export type GardenItem = (typeof GARDEN_ITEMS)[number];

export const gardenLadder = (name: string): Ladder => ({
  url: `/props/garden.glts?${new URLSearchParams({ name })}`,
  levels: [
    { type: "impostor", layout: "hemi", maxPixels: 40, resolution: 64 },
    { type: "empty", maxPixels: 3 },
  ],
});

/** Length of one clipped hedge section (m). */
export const HEDGE = 2;
/** How many hedge designs share the gardens' hedges. */
export const HEDGE_VARIANTS = 3;

/** Hedges keep their clipped outline through simplified geometry and a distant impostor. */
export const hedgeLadder = (variant: number): Ladder => ({
  url: `/props/hedge.glts?length=${HEDGE}&variant=${variant}`,
  levels: [
    { type: "simplify", ratio: 0.1, maxPixels: 120 },
    { type: "impostor", layout: "hemi", maxPixels: 30, resolution: 64 },
    { type: "empty", maxPixels: 3 },
  ],
});

/** Where a kind grows: town gardens, the open country's grassland, or the forest floor. */
export type Habitat = "garden" | "meadow" | "forest";

/** A kind of ground cover: patches of generated grass blades, or a fetched plant model. */
export type GroundKind = { name: string; ground: Habitat; density: number; reach: number; scale: [number, number] } & (
  { grass: true; variants: number } | { id: string; variants: string[] }
);

/**
 * Ground cover near the camera: grass blade by blade, wild flowers on the meadows, ferns
 * and nettles on the forest floor. A kilometre of meadow holds far too many blades to
 * list, and from a few dozen metres on the ground texture shows the same green (the
 * blades take their colour from it), so each kind lives in `Patches` of 6 m tiles filled
 * only within the distance where it still stands taller than its cull size on screen;
 * there it dithers out into the empty level. The cull size is set so that happens `reach`
 * metres away on an 800 px tall view (a 50° field of view). Every kind switches directly
 * from its original geometry to an impostor, then disappears into the ground.
 */
export const GROUND_COVER: GroundKind[] = [
  {
    name: "lawn",
    ground: "garden",
    grass: true,
    variants: 2,
    density: 4,
    reach: 18,
    scale: [0.9, 1.1],
  },
  {
    name: "meadow",
    ground: "meadow",
    grass: true,
    variants: 2,
    density: 4,
    reach: 22,
    scale: [0.8, 1.25],
  },
  {
    name: "dandelions",
    ground: "meadow",
    id: "dandelion_01",
    variants: ["dandelion_01_a_LOD0", "dandelion_01_c_LOD0"],
    density: 0.35,
    reach: 45,
    scale: [0.8, 1.2],
  },
  { name: "ferns", ground: "forest", id: "fern_02", variants: ["fern_02_a", "fern_02_b"], density: 0.3, reach: 40, scale: [0.8, 1.4] },
  {
    name: "nettles",
    ground: "forest",
    id: "nettle_plant",
    variants: ["nettle_plant_medium_a_LOD0", "nettle_plant_tall_a_LOD0"],
    density: 0.12,
    reach: 40,
    scale: [0.9, 1.3],
  },
];

/** A grass kind's variant; its empty threshold is a stand-in the app replaces from the loaded bounds. */
export const grassLadder = (kind: string, variant: number): Ladder => ({
  url: `/props/grass.glts?kind=${kind}&variant=${variant}`,
  levels: [
    { type: "impostor", layout: "hemi", resolution: 64 },
    { type: "empty", maxPixels: 1 },
  ],
});

/** A ground plant model; its empty threshold is a stand-in the app replaces from the loaded bounds. */
export const groundPlantLadder = (id: string, variant: string): Ladder => ({
  url: `/assets/models/${id}/${variant}.glb`,
  levels: [
    { type: "impostor", layout: "hemi", resolution: 64, maxPixels: 64 },
    { type: "empty", maxPixels: 1 },
  ],
});

/** A building's ladder: the source, its windows baked onto the authored low shell, then an impostor. */
function buildingLadder(url: string, baked: { textureSize: number; maxPixels: number }, impostor: { resolution: number; maxPixels: number }): Ladder {
  const part = (name: "low" | "interior") => `${url}${url.includes("?") ? "&" : "?"}part=${name}`;
  return {
    url,
    levels: [
      { type: "baked", low: part("low"), interior: part("interior"), ...baked },
      { type: "impostor", layout: "hemi", frames: 8, ...impostor },
    ],
  };
}

export const houseLadder = (variant: number): Ladder =>
  buildingLadder(`/houses/house.glts?variant=${variant}`, { textureSize: 512, maxPixels: 350 }, { resolution: 64, maxPixels: 90 });
export const CHURCH = buildingLadder("/houses/church.glts", { textureSize: 1024, maxPixels: 560 }, { resolution: 128, maxPixels: 144 });

export const PLANT_PIXELS = 1000;
export const FAR_PIXELS = 350;
export const PLANT_GONE = 215;

/** A corn plant's ladder: source, detailed impostor, coarse impostor, empty. */
export const plantLadder = (url: string): Ladder => ({
  url,
  levels: [
    { type: "impostor", layout: "hemi", maxPixels: PLANT_PIXELS, resolution: 256, frames: 8, draw: { parallax: 0 } },
    { type: "impostor", layout: "hemi", maxPixels: FAR_PIXELS, resolution: 64, frames: 8, draw: { parallax: 0 } },
    { type: "empty", maxPixels: PLANT_GONE },
  ],
});

export const cornLadder = (variant: number): Ladder => plantLadder(`/corn/plant.glts?variant=${variant}`);
export const HERO = plantLadder(`/corn/plant.glts?variant=${HERO_VARIANT}&hero=1`);
export const LADYBIRD: Ladder = {
  url: `/corn/ladybird.glts?variant=${HERO_VARIANT}`,
  levels: [
    { type: "impostor", maxPixels: 20, resolution: 64 },
    { type: "empty", maxPixels: 2 },
  ],
};

const range = (count: number) => Array.from({ length: count }, (_, index) => index);

/** Every ladder the city may request; the plan places a subset of the models, signs and garden items. */
export const LADDERS: Ladder[] = [
  ...SPECIES.flatMap((species) => species.variants.map((variant) => treeLadder(species, variant))),
  ...PROPS.map(propLadder),
  FENCE,
  ...SIGN_NAMES.map(signLadder),
  ...GARDEN_ITEMS.map(gardenLadder),
  ...range(HEDGE_VARIANTS).map(hedgeLadder),
  ...GROUND_COVER.flatMap((kind) =>
    "grass" in kind
      ? range(kind.variants).map((variant) => grassLadder(kind.name, variant))
      : kind.variants.map((variant) => groundPlantLadder(kind.id, variant)),
  ),
  ...range(HOUSE_VARIANTS).map(houseLadder),
  CHURCH,
  ...range(CORN_VARIANTS).map(cornLadder),
  HERO,
  LADYBIRD,
];

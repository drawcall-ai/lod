// Downloads the city's CC0 assets from Poly Haven and ambientCG into public/ (gitignored), each into the folder that
// loads it, so every asset folder stands alone: models become individual, centred variant GLBs in models/<id>/
// (meshopt-compressed, with encoded images shared per model: the prepared source's, with cut-outs filled as PNG). PBR
// sets become textures/<id>/{diff,nor,arm}.webp in each folder that draws them, and the HDRI assets/hdri/sky.hdr.
// Writes public/assets/manifest.json with sizes, triangle counts, model variants and credits.
//
//   pnpm --filter @drawcall/lod-example-city assets
//
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import type { Manifest } from "./assets/manifest.ts";
import { model } from "./assets/models.ts";
import { ambientSet, environment, placeSet, textureSet } from "./assets/textures.ts";

/** Poly Haven models by id, each with the variants its models/<id>/index.glts loads. */
const models: Record<string, string[]> = {
  // trees: one heavy hero, the rest light
  tree_small_02: ["tree_small_02_LOD0"],
  searsia_lucida: ["searsia_lucida_a_LOD0", "searsia_lucida_e_LOD0"],
  pine_sapling_small: ["pine_sapling_small_a", "pine_sapling_small_b"],
  // undergrowth
  shrub_02: ["shrub_02_a", "shrub_02_c"],
  fern_02: ["fern_02_a", "fern_02_b"],
  dandelion_01: ["dandelion_01_a_LOD0", "dandelion_01_c_LOD0"],
  nettle_plant: ["nettle_plant_medium_a_LOD0", "nettle_plant_tall_a_LOD0"],
  // street props: one variant, named as the model
  street_lamp_01: ["street_lamp_01"],
  painted_wooden_bench: ["painted_wooden_bench"],
  fire_hydrant: ["fire_hydrant"],
  utility_box_01: ["utility_box_01"],
  metal_trash_can: ["metal_trash_can"],
  covered_car: ["covered_car"],
  wooden_crate_01: ["wooden_crate_01"],
  planter_box_01: ["planter_box_01"],
};
/** Texture sets by the folder in public/ that draws them; assets/ is the city page's own. */
const textures: Record<string, string[]> = {
  assets: ["Grass001", "aerial_grass_rock", "asphalt_02", "brushed_concrete_04", "cobblestone_floor_04", "farm_soil", "gravel_road"],
  fence: ["wood_table_001"],
  greenhouse: ["red_brick"],
  hedge: ["leafy_grass"],
  house: ["gravel_road", "metal_plate_02", "red_brick", "white_stucco", "whitewashed_brick", "wood_table_001"],
  letterbox: ["wood_table_001"],
  shed: ["brushed_concrete_04", "corrugated_iron", "distressed_painted_planks", "white_planks_clean"],
  "street-sign": ["metal_plate_02"],
  swing: ["wood_table_001"],
};
/** The sets from ambientCG; the rest are Poly Haven's. Grass001 is a dense green lawn, which Poly Haven lacks. */
const ambientSets = new Set(["Grass001"]);
const hdri = "kloofendal_48d_partly_cloudy_puresky";
const out = fileURLToPath(new URL("../public/", import.meta.url));

await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
const manifest: Manifest = { models: {}, textures: {}, hdri: await environment(hdri, `${out}assets/`) };
for (const [folder, ids] of Object.entries(textures))
  for (const id of ids) {
    manifest.textures[id] ??= ambientSets.has(id) ? await ambientSet(id) : await textureSet(id);
    await placeSet(id, `${out}${folder}/`);
  }
for (const [id, variants] of Object.entries(models)) manifest.models[id] = await model(id, variants, io, `${out}models/${id}/`);
await writeFile(`${out}assets/manifest.json`, JSON.stringify(manifest, null, 2));

const total = (Object.values(manifest.models).reduce((s, m) => s + m.bytes, 0) + Object.values(manifest.textures).reduce((s, t) => s + t.bytes, 0)) / 1e6;
console.log(`wrote ${out}assets/manifest.json (${total.toFixed(0)} MB of models and texture sets)`);

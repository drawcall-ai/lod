// Downloads the city's CC0 assets from Poly Haven and ambientCG into public/assets/ (gitignored):
// models become individual, centred variant GLBs (meshopt-compressed, with encoded
// images shared per model and copied unchanged from the prepared source). PBR sets become webp, plus one HDRI. Writes
// public/assets/manifest.json with sizes, triangle counts and credits.
//
//   pnpm --filter @drawcall/lod-example-city assets
//
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { isManifest, type Manifest } from "../public/content/manifest.ts";
import { exists } from "./assets/files.ts";
import { model } from "./assets/models.ts";
import { ambientSet, environment, textureSet } from "./assets/textures.ts";

const models = [
  // trees: one heavy hero, the rest light
  "tree_small_02",
  "searsia_lucida",
  "pine_sapling_small",
  // undergrowth
  "shrub_02",
  "fern_02",
  "dandelion_01",
  "nettle_plant",
  // street props
  "street_lamp_01",
  "painted_wooden_bench",
  "fire_hydrant",
  "utility_box_01",
  "metal_trash_can",
  "covered_car",
  "wooden_crate_01",
  "planter_box_01",
];
const textures = [
  "white_stucco",
  "red_brick",
  "whitewashed_brick",
  "brushed_concrete_04",
  "wood_table_001",
  "distressed_painted_planks",
  "white_planks_clean",
  "corrugated_iron",
  "metal_plate_02",
  "farm_soil",
  "leafy_grass",
  "aerial_grass_rock",
  "asphalt_02",
  "cobblestone_floor_04",
  "gravel_road",
];
/**
 * ambientCG sets (they are procedural, so there is no measured size): id → metres per repeat.
 * Grass001 is a dense green lawn, which Poly Haven lacks.
 */
const ambientTextures = { Grass001: 1.2 };
const hdri = "kloofendal_48d_partly_cloudy_puresky";
const out = fileURLToPath(new URL("../public/assets/", import.meta.url));

await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
const previous = await readManifest();
const manifest: Manifest = {
  models: {},
  textures: {},
  hdri: previous?.hdri && (await exists(out + previous.hdri.file)) ? previous.hdri : await environment(hdri, out),
};
for (const id of textures) manifest.textures[id] = (await existingTexture(id)) ?? (await textureSet(id, out));
for (const [id, metres] of Object.entries(ambientTextures)) manifest.textures[id] = (await existingTexture(id)) ?? (await ambientSet(id, metres, out));

async function readManifest(): Promise<Manifest | undefined> {
  if (!(await exists(`${out}manifest.json`))) return undefined;
  const value: unknown = JSON.parse(await readFile(`${out}manifest.json`, "utf8"));
  if (!isManifest(value)) throw new Error("Invalid asset manifest");
  return value;
}

async function existingTexture(id: string): Promise<Manifest["textures"][string] | undefined> {
  const entry = previous?.textures[id];
  return entry && (await Promise.all([entry.diff, entry.nor, entry.arm].map((file) => exists(out + file)))).every(Boolean) ? entry : undefined;
}
for (const id of models) manifest.models[id] = await model(id, io, out);
await writeFile(`${out}manifest.json`, JSON.stringify(manifest, null, 2));

const total = (Object.values(manifest.models).reduce((s, m) => s + m.bytes, 0) + Object.values(manifest.textures).reduce((s, t) => s + t.bytes, 0)) / 1e6;
console.log(`wrote ${out}manifest.json (${total.toFixed(0)} MB of models and textures)`);

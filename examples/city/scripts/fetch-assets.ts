// Downloads the city's CC0 assets from Poly Haven and ambientCG into assets/ (gitignored):
// models become compact GLBs (webp textures ≤2k, meshopt-compressed, leaf cut-outs as
// alpha-tested MASK materials), PBR texture sets become webp, plus one HDRI. Writes
// assets/manifest.json with sizes, triangle counts and credits.
//
//   pnpm --filter @drawcall/lod-example-city assets
//
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type Document, NodeIO, type Texture } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { dedup, getBounds, prune, reorder, textureCompress, weld } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import { unzipSync } from "fflate";
import sharp from "sharp";
import type { Credit, Manifest } from "../src/manifest.ts";

const models = [
  // trees: one heavy hero, the rest light
  "tree_small_02",
  "searsia_lucida",
  "pine_sapling_small",
  // undergrowth
  "shrub_02",
  "shrub_04",
  "fern_02",
  "grass_medium_01",
  "grass_bermuda_01",
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
  "clay_roof_tiles_02",
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
/** Card foliage that Poly Haven marks OPAQUE although it ships an alpha map. */
const opaqueCards = new Set(["grass_bermuda_01"]);
const hdri = "kloofendal_48d_partly_cloudy_puresky";
const res = "2k";

const out = fileURLToPath(new URL("../assets/", import.meta.url));
const cache = `${out}.cache/`;
const headers = { "User-Agent": "drawcall-lod-city/0.1" };

/** `size` is known for Poly Haven files and checked; ambientCG does not publish it. */
type FileRef = { url: string; size?: number };
/** A Poly Haven files listing: map → resolution → format → file (a glTF with its `include`d files). */
type Files = Record<string, unknown>;
type Info = { name: string; authors: string[]; dimensions: number[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` at `path` of nested objects, undefined where the path breaks off. */
function at(value: unknown, path: string[]): unknown {
  for (const key of path) value = isRecord(value) ? value[key] : undefined;
  return value;
}

async function json(url: string): Promise<unknown> {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** A Poly Haven asset's files listing and info. */
async function polyHaven(id: string): Promise<{ files: Files; info: Info }> {
  const [files, info] = await Promise.all([json(`https://api.polyhaven.com/files/${id}`), json(`https://api.polyhaven.com/info/${id}`)]);
  if (!isRecord(files)) throw new Error(`${id}: files listing is not an object`);
  if (!isRecord(info) || typeof info.name !== "string" || !isRecord(info.authors) || !Array.isArray(info.dimensions)) throw new Error(`${id}: unexpected info`);
  const dimensions: unknown[] = info.dimensions;
  if (!dimensions.every((d) => typeof d === "number")) throw new Error(`${id}: dimensions are not numbers`);
  return { files, info: { name: info.name, authors: Object.keys(info.authors), dimensions } };
}

/** A Poly Haven file entry: its URL and size in bytes. */
function polyFile(value: unknown, what: string): Required<FileRef> {
  if (!isRecord(value) || typeof value.url !== "string" || typeof value.size !== "number") throw new Error(`no file ${what}`);
  return { url: value.url, size: value.size };
}

/** Downloads into the cache unless the file is already there (with the expected size, when known). */
async function download(ref: FileRef, path: string): Promise<string> {
  const size = await stat(path).then(
    (s) => s.size,
    () => -1,
  );
  if (size >= 0 && (ref.size === undefined || size === ref.size)) return path;
  const r = await fetch(ref.url, { headers });
  if (!r.ok) throw new Error(`${ref.url}: HTTP ${r.status}`);
  const data = Buffer.from(await r.arrayBuffer());
  if (ref.size !== undefined && data.length !== ref.size) throw new Error(`${ref.url}: got ${data.length} bytes, expected ${ref.size}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  return path;
}

function fileRef(files: Files, key: string, format: string): FileRef {
  return polyFile(at(files, [key, res, format]), `${key} ${res} ${format}`);
}

function credit(id: string, info: Info): Credit {
  return { name: info.name, authors: info.authors, license: "CC0-1.0", source: `https://polyhaven.com/a/${id}` };
}

/**
 * Poly Haven ships foliage with a JPG base colour and the cut-out as a separate alpha map,
 * marking the material BLEND (or MASK with nothing to mask). Merge the alpha into the base
 * colour and switch to alpha testing, which sorts and shadows correctly.
 */
async function cutOut(doc: Document, id: string, files: Files) {
  const merged = new Set<Texture>();
  for (const material of doc.getRoot().listMaterials()) {
    if (material.getAlphaMode() === "OPAQUE" && !opaqueCards.has(id)) continue;
    const base = material.getBaseColorTexture();
    if (!base) throw new Error(`${id}/${material.getName()}: ${material.getAlphaMode()} without a base colour texture`);
    const key = alphaKey(id, base.getURI());
    if (!files[key]) {
      // glass and similar: genuine translucency, keep it blended
      if (material.getAlphaMode() === "BLEND") continue;
      throw new Error(`${id}/${material.getName()}: ${material.getAlphaMode()} cut-out but no alpha map ${key}`);
    }
    if (!merged.has(base)) {
      const alpha = await download(fileRef(files, key, "jpg"), `${cache}${id}/${key}.jpg`);
      await mergeAlpha(base, alpha);
      merged.add(base);
    }
    material.setAlphaMode("MASK").setAlphaCutoff(0.5);
  }
}

/** `<id>_leaves_diff_2k.jpg` pairs with `leaves_alpha`, `<id>_diff_2k.jpg` with `Alpha`. */
function alphaKey(id: string, uri: string): string {
  const match = uri.match(new RegExp(`${id}_(\\w*?)diff_`));
  if (!match) throw new Error(`${id}: unexpected base colour name ${uri}`);
  return match[1] ? `${match[1]}alpha` : "Alpha";
}

async function mergeAlpha(texture: Texture, alphaPath: string) {
  const image = texture.getImage();
  if (!image) throw new Error(`${texture.getURI()}: no image data`);
  const { width, height } = await sharp(image).metadata();
  const alpha = await sharp(alphaPath).resize(width, height).toColourspace("b-w").raw().toBuffer();
  // no removeAlpha(): sharp orders it after joinChannel, which would drop the joined alpha again
  const png = await sharp(image)
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  if (!(await sharp(png).metadata()).hasAlpha) throw new Error(`${texture.getURI()}: alpha merge produced no alpha channel`);
  texture
    .setImage(new Uint8Array(png))
    .setMimeType("image/png")
    .setURI(texture.getURI().replace(/\.jpg$/, ".png"));
}

function triangles(doc: Document): number {
  let count = 0;
  for (const node of doc.getRoot().listNodes()) {
    for (const prim of node.getMesh()?.listPrimitives() ?? []) {
      const n = prim.getIndices()?.getCount() ?? prim.getAttribute("POSITION")?.getCount();
      if (n === undefined) throw new Error(`${node.getName()}: primitive without positions`);
      count += n / 3;
    }
  }
  return count;
}

/**
 * glTF is Y-up metres; Poly Haven lists dimensions in Z-up millimetres, measured on the
 * source scene (its numbers are loose: 1.18 m listed height for 0.35 m grass clumps). So
 * check units by the largest extent within 2×, and the up axis by the asset standing on y = 0.
 */
function checkFrame(id: string, doc: Document, info: Info): number[][] {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) throw new Error(`${id}: no scene`);
  const { min, max } = getBounds(scene);
  const extent = Math.max(...max.map((v, i) => v - (min[i] ?? 0)));
  const listed = Math.max(...info.dimensions) / 1000;
  if (extent > 2 * listed || extent < listed / 2) throw new Error(`${id}: glTF extent ${extent.toFixed(3)} m but Poly Haven lists ${listed.toFixed(3)} m`);
  const height = max[1] - min[1];
  if (Math.abs(min[1]) > 0.1 * height + 0.05) throw new Error(`${id}: does not stand on y = 0 (y from ${min[1].toFixed(3)} to ${max[1].toFixed(3)})`);
  return [min.map((v) => +v.toFixed(4)), max.map((v) => +v.toFixed(4))];
}

async function model(id: string, io: NodeIO): Promise<Manifest["models"][string]> {
  const { files, info } = await polyHaven(id);
  const gltf = at(files, ["gltf", res, "gltf"]);
  const include = at(gltf, ["include"]);
  if (!isRecord(include)) throw new Error(`${id}: no ${res} glTF`);
  const dir = `${cache}${id}/`;
  await Promise.all(Object.entries(include).map(([name, ref]) => download(polyFile(ref, `${id}/${name}`), dir + name)));
  const path = await download(polyFile(gltf, `${id} glTF`), `${dir}${id}.gltf`);

  const doc = await io.read(path);
  await cutOut(doc, id, files);
  await doc.transform(
    dedup(),
    weld(),
    prune(),
    reorder({ encoder: MeshoptEncoder }),
    textureCompress({ encoder: sharp, targetFormat: "webp", resize: [2048, 2048], quality: 88 }),
  );
  // FILTER keeps positions and UVs as lossless float; normals become 8-bit octahedral.
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  const bounds = checkFrame(id, doc, info);
  const file = `models/${id}.glb`;
  await mkdir(`${out}models`, { recursive: true });
  await writeFile(out + file, await io.writeBinary(doc));
  const bytes = (await stat(out + file)).size;
  const variants =
    doc
      .getRoot()
      .listScenes()[0]
      ?.listChildren()
      .map((n) => n.getName()) ?? [];
  const entry = { file, bytes, triangles: triangles(doc), bounds, variants, credit: credit(id, info) };
  console.log(`${id.padEnd(22)} ${String(entry.triangles).padStart(9)} tris ${(bytes / 1e6).toFixed(1).padStart(6)} MB`);
  return entry;
}

const maps = { diff: "Diffuse", nor: "nor_gl", arm: "arm" } as const;

async function textureSet(id: string): Promise<Manifest["textures"][string]> {
  const { files, info } = await polyHaven(id);
  await mkdir(`${out}textures/${id}`, { recursive: true });
  const written: Record<string, string> = {};
  let bytes = 0;
  for (const [name, key] of Object.entries(maps)) {
    const jpg = await download(fileRef(files, key, "jpg"), `${cache}${id}/${key}.jpg`);
    const file = `textures/${id}/${name}.webp`;
    await sharp(jpg)
      .webp({ quality: name === "nor" ? 92 : 86 })
      .toFile(out + file);
    bytes += (await stat(out + file)).size;
    written[name] = file;
  }
  const [w = 0, h = 0] = info.dimensions;
  const { diff, nor, arm } = written;
  if (!diff || !nor || !arm) throw new Error(`${id}: missing maps`);
  console.log(`${id.padEnd(28)} ${(w / 1000).toFixed(2)} m  ${(bytes / 1e6).toFixed(1).padStart(5)} MB`);
  return { diff, nor, arm, size: [w / 1000, h / 1000], bytes, credit: credit(id, info) };
}

/** An ambientCG 1K set: colour and GL normal as they are, AO and roughness packed into arm like Poly Haven's. */
async function ambientSet(id: string, metres: number): Promise<Manifest["textures"][string]> {
  const zip = await download({ url: `https://ambientcg.com/get?file=${id}_1K-JPG.zip` }, `${cache}${id}/${id}_1K-JPG.zip`);
  const files = unzipSync(new Uint8Array(await readFile(zip)));
  const part = (suffix: string) => {
    const data = files[`${id}_1K-JPG_${suffix}.jpg`];
    if (!data) throw new Error(`${id}: zip has no ${suffix} map`);
    return Buffer.from(data);
  };
  await mkdir(`${out}textures/${id}`, { recursive: true });
  const diff = `textures/${id}/diff.webp`;
  const nor = `textures/${id}/nor.webp`;
  const arm = `textures/${id}/arm.webp`;
  await sharp(part("Color"))
    .webp({ quality: 86 })
    .toFile(out + diff);
  await sharp(part("NormalGL"))
    .webp({ quality: 92 })
    .toFile(out + nor);
  const { width, height } = await sharp(part("Color")).metadata();
  const grey = (b: Buffer) => sharp(b).resize(width, height).toColourspace("b-w").raw().toBuffer();
  const raw = { width, height, channels: 1 } as const;
  const metal = Buffer.alloc(width * height);
  await sharp(await grey(part("AmbientOcclusion")), { raw })
    .joinChannel([await grey(part("Roughness")), metal], { raw })
    .webp({ quality: 90 })
    .toFile(out + arm);
  let bytes = 0;
  for (const f of [diff, nor, arm]) bytes += (await stat(out + f)).size;
  console.log(`${id.padEnd(28)} ${metres.toFixed(2)} m  ${(bytes / 1e6).toFixed(1).padStart(5)} MB`);
  return {
    diff,
    nor,
    arm,
    size: [metres, metres],
    bytes,
    credit: { name: id, authors: ["ambientCG"], license: "CC0-1.0", source: `https://ambientcg.com/view?id=${id}` },
  };
}

async function environment(id: string): Promise<Manifest["hdri"]> {
  const { files, info } = await polyHaven(id);
  const file = `hdri/${id}_${res}.hdr`;
  await download(fileRef(files, "hdri", "hdr"), out + file);
  return { file, credit: credit(id, info) };
}

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder });
const manifest: Manifest = { models: {}, textures: {}, hdri: await environment(hdri) };
for (const id of textures) manifest.textures[id] = await textureSet(id);
for (const [id, metres] of Object.entries(ambientTextures)) manifest.textures[id] = await ambientSet(id, metres);
for (const id of models) manifest.models[id] = await model(id, io);
await writeFile(`${out}manifest.json`, JSON.stringify(manifest, null, 2));

const total = (Object.values(manifest.models).reduce((s, m) => s + m.bytes, 0) + Object.values(manifest.textures).reduce((s, t) => s + t.bytes, 0)) / 1e6;
console.log(`wrote ${out}manifest.json (${total.toFixed(0)} MB of models and textures)`);

import { mkdir, writeFile } from "node:fs/promises";
import type { Document, NodeIO, Texture } from "@gltf-transform/core";
import { EXTMeshoptCompression } from "@gltf-transform/extensions";
import { dedup, getBounds, prune, reorder, textureCompress, weld } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";
import type { Manifest } from "../../public/content/manifest.ts";
import { cache, download, exists } from "./files.ts";
import { credit, downloadModel, fileRef, polyHaven, type Files, type Info } from "./polyhaven.ts";
import { variant, writeVariant } from "./variants.ts";

/**
 * Poly Haven ships foliage with a JPG base colour and the cut-out as a separate alpha map,
 * marking the material BLEND (or MASK with nothing to mask). Merge the alpha into the base
 * colour and switch to alpha testing, which sorts and shadows correctly.
 */
async function cutOut(doc: Document, id: string, files: Files) {
  const merged = new Set<Texture>();
  for (const material of doc.getRoot().listMaterials()) {
    if (material.getAlphaMode() === "OPAQUE") continue;
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

/** Street props are assembled parts, while each plant's root node is an independent variant. */
const props: Record<string, string[]> = {
  street_lamp_01: ["street_lamp_01"],
  painted_wooden_bench: ["painted_wooden_bench"],
  fire_hydrant: ["fire_hydrant", "fire_hydrant_cap_01", "fire_hydrant_cap_02", "fire_hydrant_cap_03", "fire_hydrant_chain"],
  utility_box_01: ["utility_box_01_box"],
  metal_trash_can: ["metal_trash_can", "metal_trash_can_lid", "metal_trash_can_handle_left", "metal_trash_can_handle_right"],
  covered_car: ["covered_car", "covered_car_wheel_01", "covered_car_wheel_02", "covered_car_wheel_03", "covered_car_wheel_04"],
  wooden_crate_01: ["wooden_crate_01", "wooden_crate_01_lid", "wooden_crate_01_latch"],
  planter_box_01: ["planter_box_01"],
};

export async function model(id: string, io: NodeIO, out: string): Promise<Manifest["models"][string]> {
  const { files, info } = await polyHaven(id);
  const source = `${cache}${id}/model.glb`;
  let doc: Document;
  if (await exists(source)) doc = await io.read(source);
  else {
    doc = await io.read(await downloadModel(id, files));
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
    await writeFile(source, await io.writeBinary(doc));
  }
  const bounds = checkFrame(id, doc, info);
  const parts = props[id];
  const selections = parts
    ? [[id, parts] as const]
    : doc
        .getRoot()
        .listScenes()[0]
        ?.listChildren()
        .map((node) => [node.getName(), [node.getName()]] as const);
  if (!selections?.length) throw new Error(`${id}: no model variants`);
  await mkdir(`${out}models/${id}`, { recursive: true });
  let bytes = 0;
  const images = new Map<string, Uint8Array>();
  for (const [name, names] of selections) {
    const file = `${out}models/${id}/${name}.glb`;
    const output = await writeVariant(io, await variant(doc, name, names, parts !== undefined));
    await writeFile(file, output.binary);
    bytes += output.binary.byteLength;
    for (const [uri, image] of output.images) images.set(uri, image);
  }
  await mkdir(`${out}models/${id}/images`, { recursive: true });
  for (const [uri, image] of images) {
    await writeFile(`${out}models/${id}/${uri}`, image);
    bytes += image.byteLength;
  }
  const entry = { bytes, triangles: triangles(doc), bounds, variants: selections.map(([name]) => name), credit: credit(id, info) };
  console.log(`${id.padEnd(22)} ${String(entry.triangles).padStart(9)} tris ${(bytes / 1e6).toFixed(1).padStart(6)} MB (${entry.variants.length} variants)`);
  return entry;
}

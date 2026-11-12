import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { unzipSync } from "fflate";
import sharp from "sharp";
import type { Manifest } from "./manifest.ts";
import { cache, download } from "./files.ts";
import { credit, fileRef, polyHaven } from "./polyhaven.ts";

const maps = ["diff", "nor", "arm"] as const;
type MapName = (typeof maps)[number];
/** Poly Haven's name of each map. */
const keys = { diff: "Diffuse", nor: "nor_gl", arm: "arm" } as const;

/** Where set `id`'s map is encoded, once, for every folder that draws the set. */
const encoded = (id: string, map: MapName) => `${cache}${id}/${map}.webp`;

/** Copies set `id`, encoded by `textureSet` or `ambientSet`, into `folder` as textures/<id>/{diff,nor,arm}.webp. */
export async function placeSet(id: string, folder: string): Promise<void> {
  await mkdir(`${folder}textures/${id}`, { recursive: true });
  for (const map of maps) await copyFile(encoded(id, map), `${folder}textures/${id}/${map}.webp`);
}

/** Bytes of set `id`'s encoded maps. */
async function bytes(id: string): Promise<number> {
  let total = 0;
  for (const map of maps) total += (await stat(encoded(id, map))).size;
  return total;
}

/** A Poly Haven 2K set, encoded as webp. */
export async function textureSet(id: string): Promise<Manifest["textures"][string]> {
  const { files, info } = await polyHaven(id);
  for (const map of maps) {
    const jpg = await download(fileRef(files, keys[map], "jpg"), `${cache}${id}/${keys[map]}.jpg`);
    await sharp(jpg)
      .webp({ quality: map === "nor" ? 92 : 86 })
      .toFile(encoded(id, map));
  }
  // the assets drawing a set tile it by this size, which they hold in their code
  const [w = 0, h = 0] = info.dimensions;
  const size = await bytes(id);
  console.log(`${id.padEnd(28)} ${(w / 1000).toFixed(2)} × ${(h / 1000).toFixed(2)} m  ${(size / 1e6).toFixed(1).padStart(5)} MB`);
  return { bytes: size, credit: credit(id, info) };
}

/** An ambientCG 1K set: colour and GL normal as they are, AO and roughness packed into arm like Poly Haven's. */
export async function ambientSet(id: string): Promise<Manifest["textures"][string]> {
  const zip = await download({ url: `https://ambientcg.com/get?file=${id}_1K-JPG.zip` }, `${cache}${id}/${id}_1K-JPG.zip`);
  const files = unzipSync(new Uint8Array(await readFile(zip)));
  const part = (suffix: string) => {
    const data = files[`${id}_1K-JPG_${suffix}.jpg`];
    if (!data) throw new Error(`${id}: zip has no ${suffix} map`);
    return Buffer.from(data);
  };
  await sharp(part("Color")).webp({ quality: 86 }).toFile(encoded(id, "diff"));
  await sharp(part("NormalGL")).webp({ quality: 92 }).toFile(encoded(id, "nor"));
  const { width, height } = await sharp(part("Color")).metadata();
  const grey = (b: Buffer) => sharp(b).resize(width, height).toColourspace("b-w").raw().toBuffer();
  const raw = { width, height, channels: 1 } as const;
  const metal = Buffer.alloc(width * height);
  await sharp(await grey(part("AmbientOcclusion")), { raw })
    .joinChannel([await grey(part("Roughness")), metal], { raw })
    .webp({ quality: 90 })
    .toFile(encoded(id, "arm"));
  const size = await bytes(id);
  console.log(`${id.padEnd(28)} ${(size / 1e6).toFixed(1).padStart(5)} MB`);
  return {
    bytes: size,
    credit: { name: id, authors: ["ambientCG"], license: "CC0-1.0", source: `https://ambientcg.com/view?id=${id}` },
  };
}

export async function environment(id: string, folder: string): Promise<Manifest["hdri"]> {
  const { files, info } = await polyHaven(id);
  await download(fileRef(files, "hdri", "hdr"), `${folder}hdri/sky.hdr`);
  return { credit: credit(id, info) };
}

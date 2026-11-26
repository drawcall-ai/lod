import { copyFile, mkdir, stat } from "node:fs/promises";
import sharp from "sharp";
import type { Manifest } from "./manifest.ts";
import { cache, download } from "./files.ts";
import { credit, fileRef, polyHaven } from "./polyhaven.ts";

const maps = ["diff", "nor", "arm"] as const;
type MapName = (typeof maps)[number];
/** Poly Haven's name of each map. */
const keys = { diff: "Diffuse", nor: "nor_gl", arm: "arm" } as const;

/** Where set `id`'s map is encoded. */
const encoded = (id: string, map: MapName) => `${cache}${id}/${map}.webp`;

/** Copies set `id`, encoded by `textureSet`, into `folder` as textures/<id>/{diff,nor,arm}.webp. */
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

export async function environment(id: string, folder: string): Promise<Manifest["hdri"]> {
  const { files, info } = await polyHaven(id);
  await download(fileRef(files, "hdri", "hdr"), `${folder}hdri/sky.hdr`);
  return { credit: credit(id, info) };
}

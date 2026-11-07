import { mkdir, readFile, stat } from "node:fs/promises";
import { unzipSync } from "fflate";
import sharp from "sharp";
import type { Manifest } from "../../public/content/manifest.ts";
import { cache, download } from "./files.ts";
import { credit, fileRef, polyHaven, res } from "./polyhaven.ts";

const maps = { diff: "Diffuse", nor: "nor_gl", arm: "arm" } as const;

export async function textureSet(id: string, out: string): Promise<Manifest["textures"][string]> {
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
export async function ambientSet(id: string, metres: number, out: string): Promise<Manifest["textures"][string]> {
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

export async function environment(id: string, out: string): Promise<Manifest["hdri"]> {
  const { files, info } = await polyHaven(id);
  const file = `hdri/${id}_${res}.hdr`;
  await download(fileRef(files, "hdri", "hdr"), out + file);
  return { file, credit: credit(id, info) };
}

import { readFile } from "node:fs/promises";
import type { Credit } from "../../public/content/manifest.ts";
import { cache, download, type FileRef } from "./files.ts";

export const res = "2k";

/** A Poly Haven files listing: map → resolution → format → file (a glTF with its `include`d files). */
export type Files = Record<string, unknown>;
export type Info = { name: string; authors: string[]; dimensions: number[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` at `path` of nested objects, undefined where the path breaks off. */
function at(value: unknown, path: string[]): unknown {
  for (const key of path) value = isRecord(value) ? value[key] : undefined;
  return value;
}

async function json(url: string, path: string): Promise<unknown> {
  await download({ url }, path);
  return JSON.parse(await readFile(path, "utf8"));
}

/** A Poly Haven asset's files listing and info. */
export async function polyHaven(id: string): Promise<{ files: Files; info: Info }> {
  const [files, info] = await Promise.all([
    json(`https://api.polyhaven.com/files/${id}`, `${cache}${id}/files.json`),
    json(`https://api.polyhaven.com/info/${id}`, `${cache}${id}/info.json`),
  ]);
  if (!isRecord(files)) throw new Error(`${id}: files listing is not an object`);
  if (!isRecord(info) || typeof info.name !== "string" || !isRecord(info.authors) || (info.dimensions !== undefined && !Array.isArray(info.dimensions)))
    throw new Error(`${id}: unexpected info`);
  const dimensions: unknown[] = info.dimensions ?? [];
  if (!dimensions.every((d) => typeof d === "number")) throw new Error(`${id}: dimensions are not numbers`);
  return { files, info: { name: info.name, authors: Object.keys(info.authors), dimensions } };
}

/** A Poly Haven file entry: its URL and size in bytes. */
function polyFile(value: unknown, what: string): Required<FileRef> {
  if (!isRecord(value) || typeof value.url !== "string" || typeof value.size !== "number") throw new Error(`no file ${what}`);
  return { url: value.url, size: value.size };
}

export function fileRef(files: Files, key: string, format: string): FileRef {
  return polyFile(at(files, [key, res, format]), `${key} ${res} ${format}`);
}

export function credit(id: string, info: Info): Credit {
  return { name: info.name, authors: info.authors, license: "CC0-1.0", source: `https://polyhaven.com/a/${id}` };
}

export async function downloadModel(id: string, files: Files): Promise<string> {
  const gltf = at(files, ["gltf", res, "gltf"]);
  const include = at(gltf, ["include"]);
  if (!isRecord(include)) throw new Error(`${id}: no ${res} glTF`);
  const dir = `${cache}${id}/`;
  await Promise.all(Object.entries(include).map(([name, ref]) => download(polyFile(ref, `${id}/${name}`), dir + name)));
  return download(polyFile(gltf, `${id} glTF`), `${dir}${id}.gltf`);
}

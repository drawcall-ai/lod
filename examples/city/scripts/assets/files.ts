import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const cache = fileURLToPath(new URL("../../.cache/assets/", import.meta.url));
const headers = { "User-Agent": "drawcall-lod-city/0.1" };

/** Known sizes are checked; ambientCG does not publish them. */
export type FileRef = { url: string; size?: number };

/** Downloads into the cache unless the file is already there (with the expected size, when known). */
export async function download(ref: FileRef, path: string): Promise<string> {
  const size = await stat(path).then(
    (s) => s.size,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return -1;
      throw error;
    },
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

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

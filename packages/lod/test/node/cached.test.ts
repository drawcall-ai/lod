import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { CachedLodLoader } from "../../src/loader/node.js";
import type { LodRequest } from "../../src/loader/request.js";
import { LoadingManager } from "three/webgpu";

const root = fileURLToPath(new URL(".", import.meta.url));
const directory = join(root, "public/_vitecache");
afterAll(() => rm(directory, { recursive: true, force: true }));

const saved = async () => {
  const names = (await readdir(directory)).sort();
  return Promise.all(names.map(async (name) => [name, (await stat(join(directory, name))).mtimeMs]));
};

it("builds and saves every level with the public files the ladder read, which a second load reads", { timeout: 120_000 }, async () => {
  const request: LodRequest = {
    url: "/box.glts?size=2",
    levels: [
      { type: "simplify", ratio: 0.5, maxPixels: 100 },
      { type: "impostor", resolution: 64 },
    ],
  };
  const { fetch } = globalThis;
  await new CachedLodLoader(undefined, { root }).loadAsync(request);
  expect(globalThis.fetch).toBe(fetch);
  const entries = await saved();
  // The shape and both levels.
  expect(entries).toHaveLength(6);
  for (const [name] of entries) {
    if (!String(name).endsWith(".json")) continue;
    const { inputs } = JSON.parse(await readFile(join(directory, String(name)), "utf8"));
    expect(inputs.map(({ dependency }: { dependency: unknown }) => dependency)).toEqual([
      { path: "public/box.glts" },
      { path: "public/box.ts" },
      { package: "three" },
    ]);
  }
  await new CachedLodLoader(undefined, { root }).loadAsync(request);
  expect(await saved()).toEqual(entries);
});

it("runs loads on one loader concurrently, each with its own GLTSLoader", { timeout: 120_000 }, async () => {
  const loader = new CachedLodLoader(undefined, { root });
  const request = (size: number): LodRequest => ({ url: `/box.glts?size=${size}`, levels: [{ type: "simplify", ratio: 0.5, maxPixels: 100 }] });
  const ladders = await Promise.all([loader.loadAsync(request(3)), loader.loadAsync(request(4))]);
  expect(ladders.map((levels) => levels.length)).toEqual([2, 2]);
});

it("refuses a manager, which would load what it cannot record", () => {
  expect(() => new CachedLodLoader(new LoadingManager())).toThrow(/without a manager/);
});

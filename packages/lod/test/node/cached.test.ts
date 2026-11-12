import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { CachedLodLoader } from "../../src/loader/node.js";
import type { LodRequest } from "../../src/loader/request.js";
import { LoadingManager } from "three/webgpu";

const root = fileURLToPath(new URL(".", import.meta.url));
const directory = join(root, "public/_vitecache");
// vitecache's project without its plugin: the working directory, its public directory and cache.
beforeAll(() => void vi.spyOn(process, "cwd").mockReturnValue(root));
afterAll(() => rm(directory, { recursive: true, force: true }));

const saved = async () => {
  const names = (await readdir(directory)).sort();
  return Promise.all(names.map(async (name) => [name, (await stat(join(directory, name))).mtimeMs]));
};

it("builds and saves every level with the public files and packages the ladder read, which a second load reads", { timeout: 120_000 }, async () => {
  const request: LodRequest = {
    url: "/box.glts?size=2",
    levels: [
      { type: "simplify", ratio: 0.5, maxPixels: 100 },
      { type: "impostor", resolution: 64 },
    ],
  };
  const { fetch } = globalThis;
  await new CachedLodLoader().loadAsync(request);
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
      { package: "@drawcall/glts" },
      { package: "three" },
    ]);
  }
  await new CachedLodLoader().loadAsync(request);
  expect(await saved()).toEqual(entries);
});

it("runs loads on one loader concurrently, each with its own GLTSLoader and bake renderer", { timeout: 120_000 }, async () => {
  const loader = new CachedLodLoader();
  const ladders = await Promise.all([
    loader.loadAsync({ url: "/box.glts?size=3", levels: [{ type: "simplify", ratio: 0.5, maxPixels: 100 }] }),
    loader.loadAsync({ url: "/box.glts?size=4", levels: [{ type: "impostor", resolution: 32 }] }),
  ]);
  expect(ladders.map((levels) => levels.length)).toEqual([2, 2]);
  // A level a camera needs once loadAsync has resolved loads in a session of its own.
  const source = await ladders[0]?.[0]?.load?.();
  expect(source?.getObjectByProperty("isMesh", true)).toBeDefined();
});

it("fails a load that fetches what it cannot record", { timeout: 120_000 }, async () => {
  // GLTS reports the script's failure, caused by the refused fetch.
  await expect(new CachedLodLoader().loadAsync("/fetch.glts")).rejects.toMatchObject({
    cause: { message: expect.stringMatching(/cannot precompute/) },
  });
});

it("stores a load at a public file's file: URL, as a headless .glts script's manager resolves it, under its served path", { timeout: 120_000 }, async () => {
  const request = (url: string): LodRequest => ({ url, levels: [{ type: "simplify", ratio: 0.5, maxPixels: 100 }] });
  await new CachedLodLoader().loadAsync(request("/box.glts?size=5"));
  const entries = await saved();
  const manager = new LoadingManager();
  manager.setURLModifier((url) => new URL(url, pathToFileURL(join(root, "public/"))).href);
  await new CachedLodLoader(manager).loadAsync(request("./box.glts?size=5"));
  expect(await saved()).toEqual(entries);
});

it("stores a load under its served path when the process has a document, as a headless GLTS renderer installs", { timeout: 120_000 }, async () => {
  const request: LodRequest = { url: "/box.glts?size=6", levels: [{ type: "simplify", ratio: 0.5, maxPixels: 100 }] };
  await new CachedLodLoader().loadAsync(request);
  const entries = await saved();
  vi.stubGlobal("document", { baseURI: pathToFileURL(join(root, "public/")).href });
  try {
    await new CachedLodLoader().loadAsync(request);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(await saved()).toEqual(entries);
});

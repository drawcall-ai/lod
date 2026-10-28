import { Group, Mesh, MeshStandardMaterial, SphereGeometry } from "three/webgpu";
import { expect, it, vi } from "vitest";
import { LazyLevel, LodLoader, type LodRequest } from "../../src/index.js";

it("fetches only the index when warm, then only each demanded level, preserving their thresholds", async () => {
  const material = new MeshStandardMaterial({ name: "surface" });
  const source = vi.fn(async () => new Group().add(new Mesh(new SphereGeometry(1, 16, 12), material)));
  const request: LodRequest = {
    source,
    key: { fixture: { value: crypto.randomUUID() } },
    material: (name) => (name === "surface" ? material : undefined),
    levels: [
      { type: "mesh", ratio: 0.5, maxPixels: 300 },
      { type: "mesh", ratio: 0.2, maxPixels: 100 },
    ],
  };
  const fetches = vi.spyOn(globalThis, "fetch");
  const writes = () => fetches.mock.calls.filter(([url, options]) => String(url).includes("/_vitecache/") && options?.method === "PUT");
  const reads = () =>
    fetches.mock.calls.filter(([url, options]) => /\/_vitecache\/[^/]+\.bin$/.test(String(url)) && !options?.method).map(([url]) => String(url));
  try {
    const loader = new LodLoader();
    const cold = await loader.loadAsync(request);
    expect(writes()).toHaveLength(3);
    const [sourceWrite, middleWrite, indexWrite] = writes();
    if (!sourceWrite || !middleWrite || !indexWrite) throw new Error("Expected source, middle and index writes");
    cold.dispose();
    fetches.mockClear();
    const warm = await loader.loadAsync(request);
    expect(source).toHaveBeenCalledOnce();
    expect(reads()).toEqual([String(indexWrite[0])]);
    expect(writes()).toHaveLength(0);
    const first = warm.levels[0]?.object,
      middle = warm.levels[1]?.object;
    if (!(first instanceof LazyLevel) || !(middle instanceof LazyLevel)) throw new Error("Expected two cached lazy levels");
    expect(warm.levels.map((level) => level.maxPixels)).toEqual([Infinity, 300, 100]);
    await first.load();
    expect(reads()).toEqual([String(indexWrite[0]), String(sourceWrite[0])]);
    await middle.load();
    expect(reads()).toEqual([String(indexWrite[0]), String(sourceWrite[0]), String(middleWrite[0])]);
    expect(source).toHaveBeenCalledOnce();
    expect(writes()).toHaveLength(0);
    warm.dispose();
  } finally {
    fetches.mockRestore();
  }
}, 120_000);

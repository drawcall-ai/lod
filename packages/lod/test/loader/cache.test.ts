import { LoadingManager } from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { expect, it, vi } from "vitest";
import { loadOnce } from "../../src/deferred.js";
import { LodLoader, type LodRequest } from "../../src/index.js";

it("resolves an alias for cache identity while loading each URL through its manager only once", async () => {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith("/test/loader/")) throw new Error("URL modifier applied to an already resolved URL");
    return url.replace("/alias/", "/test/loader/");
  });
  const source = vi.spyOn(GLTFLoader.prototype, "loadAsync");
  const request: LodRequest = {
    url: `/alias/sphere.gltf?run=${crypto.randomUUID()}`,
    levels: [
      { type: "simplify", ratio: 0.5, maxPixels: 300 },
      { type: "simplify", ratio: 0.2, maxPixels: 100 },
    ],
  };
  const fetches = vi.spyOn(globalThis, "fetch");
  const writes = () => fetches.mock.calls.filter(([url, options]) => String(url).includes("/_vitecache/") && options?.method === "PUT");
  const reads = () =>
    fetches.mock.calls.filter(([url, options]) => /\/_vitecache\/[^/]+\.bin$/.test(String(url)) && !options?.method).map(([url]) => String(url));
  try {
    const loader = new LodLoader(manager);
    await loader.loadAsync(request);
    expect(writes()).toHaveLength(2);
    const [middleWrite, indexWrite] = writes();
    if (!middleWrite || !indexWrite) throw new Error("Expected middle and index writes");
    fetches.mockClear();
    const warm = await loader.loadAsync(request);
    expect(source).toHaveBeenCalledTimes(2);
    expect(reads()).toEqual([String(indexWrite[0])]);
    const first = warm[0],
      middle = warm[1];
    if (!first?.load || !middle?.load) throw new Error("Expected two lazy levels");
    expect(warm.map((level) => level.maxPixels)).toEqual([Infinity, 300, 100]);
    await loadOnce(first.load).promise;
    await middle.load();
    expect(reads()).toEqual([String(indexWrite[0]), String(middleWrite[0])]);
    expect(source).toHaveBeenCalledTimes(2);
    expect(writes()).toHaveLength(0);
  } finally {
    fetches.mockRestore();
    source.mockRestore();
  }
}, 120_000);

it("resolves a warm impostor without source-graph fetches", async () => {
  const { GLTSLoader } = await import("@drawcall/glts");
  const manager = new LoadingManager();
  const scripts = new GLTSLoader(manager);
  manager.addHandler(/\.glts$/, scripts);
  const fetches = vi.spyOn(globalThis, "fetch");
  const loader = new LodLoader(manager);
  const freshManager = new LoadingManager();
  const freshScripts = new GLTSLoader(freshManager);
  freshManager.addHandler(/\.glts$/, freshScripts);
  const freshLoad = vi.spyOn(freshScripts, "loadAsync");
  const constructed = vi.fn();
  window.addEventListener("lod-source-constructed", constructed);
  const request: LodRequest = {
    url: `/test/loader/source.glts?size=2&run=${crypto.randomUUID()}`,
    levels: [{ type: "impostor", frames: 2, resolution: 8, maxPixels: 50 }],
  };
  try {
    await loader.loadAsync(request);
    const writes = fetches.mock.calls.filter(([url, options]) => /\/_vitecache\/[^/]+\.bin$/.test(String(url)) && options?.method === "PUT");
    expect(writes).toHaveLength(1);
    fetches.mockClear();
    const warm = await new LodLoader(freshManager).loadAsync(request);
    // The impostor is the coarsest level, so the index embeds it.
    expect(
      fetches.mock.calls.filter(([url, options]) => /\/_vitecache\/[^/]+\.bin$/.test(String(url)) && !options?.method).map(([url]) => String(url)),
    ).toEqual(writes.map(([url]) => String(url)));
    const sourceFetches = fetches.mock.calls.filter(([url]) => /\/test\/loader\/source\.(glts|ts)(?:\?|$)/.test(String(url)));
    expect(sourceFetches).toHaveLength(0);
    expect(freshLoad).not.toHaveBeenCalled();
    expect(constructed).toHaveBeenCalledOnce();
    const source = warm[0];
    if (!source?.load) throw new Error("Expected deferred GLTS source");
    const pending = source.load();
    expect(freshLoad).toHaveBeenCalledOnce();
    const object = await pending;
    const sourceMetadata: unknown = Reflect.get(object, "source");
    if (typeof sourceMetadata !== "object" || sourceMetadata === null || !("dependencyUrls" in sourceMetadata)) throw new Error("Expected source provenance");
    expect(sourceMetadata.dependencyUrls).toContain(new URL("/test/loader/source.ts", location.href).href);
    expect(freshLoad).toHaveBeenCalledOnce();
    expect(constructed).toHaveBeenCalledTimes(2);
  } finally {
    window.removeEventListener("lod-source-constructed", constructed);
    fetches.mockRestore();
    freshScripts.dispose();
    scripts.dispose();
  }
}, 120_000);

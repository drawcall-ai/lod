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
    const cold = await loader.loadAsync(request);
    // No level is built before a view selects it: only the source's shape is saved.
    const [shapeWrite, ...levelWrites] = writes();
    if (!shapeWrite) throw new Error("Expected the shape's write");
    expect(levelWrites).toHaveLength(0);
    const coarse = cold[2];
    if (!coarse?.load) throw new Error("Expected a lazy coarsest level");
    await coarse.load();
    // Built from the source measured for the shape; it draws with the source level's materials, which load the source.
    expect(source).toHaveBeenCalledTimes(2);
    expect(writes()).toHaveLength(2);
    fetches.mockClear();
    const warm = await loader.loadAsync(request);
    // The cached shape describes the ladder, so neither the source nor a level loads.
    expect(source).toHaveBeenCalledTimes(2);
    expect(reads()).toEqual([String(shapeWrite[0])]);
    const first = warm[0],
      middle = warm[1];
    if (!first?.load || !middle?.load) throw new Error("Expected two lazy levels");
    expect(warm.map((level) => level.maxPixels)).toEqual([Infinity, 300, 100]);
    await loadOnce(first.load).promise;
    expect(source).toHaveBeenCalledTimes(3);
    await middle.load();
    const [middleWrite, ...rest] = writes();
    if (!middleWrite) throw new Error("Expected the middle level's write on demand");
    expect(rest).toHaveLength(0);
    expect(reads()).toEqual([String(shapeWrite[0]), String(middleWrite[0])]);
    expect(source).toHaveBeenCalledTimes(4);
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
    const impostor = (await loader.loadAsync(request))[1];
    if (!impostor?.load) throw new Error("Expected a lazy impostor");
    await impostor.load();
    const built = constructed.mock.calls.length;
    const writes = fetches.mock.calls.filter(([url, options]) => /\/_vitecache\/[^/]+\.bin$/.test(String(url)) && options?.method === "PUT");
    // The shape, then the impostor.
    expect(writes).toHaveLength(2);
    fetches.mockClear();
    const warm = await new LodLoader(freshManager).loadAsync(request);
    expect(
      fetches.mock.calls.filter(([url, options]) => /\/_vitecache\/[^/]+\.bin$/.test(String(url)) && !options?.method).map(([url]) => String(url)),
    ).toEqual([String(writes[0]?.[0])]);
    const sourceFetches = fetches.mock.calls.filter(([url]) => /\/test\/loader\/source\.(glts|ts)(?:\?|$)/.test(String(url)));
    expect(sourceFetches).toHaveLength(0);
    expect(freshLoad).not.toHaveBeenCalled();
    expect(constructed).toHaveBeenCalledTimes(built);
    const source = warm[0];
    if (!source?.load) throw new Error("Expected deferred GLTS source");
    const pending = source.load();
    expect(freshLoad).toHaveBeenCalledOnce();
    const object = await pending;
    const sourceMetadata: unknown = Reflect.get(object, "source");
    if (typeof sourceMetadata !== "object" || sourceMetadata === null || !("dependencyUrls" in sourceMetadata)) throw new Error("Expected source provenance");
    expect(sourceMetadata.dependencyUrls).toContain(new URL("/test/loader/source.ts", location.href).href);
    expect(freshLoad).toHaveBeenCalledOnce();
    expect(constructed).toHaveBeenCalledTimes(built + 1);
  } finally {
    window.removeEventListener("lod-source-constructed", constructed);
    fetches.mockRestore();
    freshScripts.dispose();
    scripts.dispose();
  }
}, 120_000);

import { baked, cache, gltsScene, sourceFixture } from "./fixture.js";
import { GLTSLoader } from "@drawcall/glts";
import { LoadingManager } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { house, interior, low } from "../house.js";
import { bakeImpostor } from "../../src/impostor/bake/index.js";
import { LodLoader } from "../../src/loader.js";
import { Provenance } from "../../src/loader/provenance.js";

vi.mock("vitecache", async () => {
  const { CacheEntry, MissingDependencyError } = await import("./fixture.js");
  return { CacheEntry, MissingDependencyError };
});
vi.mock("../../src/impostor/bake/index.js", async () => ({ bakeImpostor: (await import("./fixture.js")).bakeImpostor }));

const script = "/models/tree.glts?seed=2&variant=a/b";
const canonical = "/models/resolved/tree.glts?seed=2&variant=a/b";
const helper = "/models/helper.bin?shape=oak";
const remote = "https://cdn.test/sky.hdr";

function fixture(metadata: (url: string) => unknown, type = "glts") {
  const source = sourceFixture((url) => {
    const scene = url.includes("rooms.glts") ? interior() : url.includes("low.glts") ? low() : house();
    return type === "glts" ? gltsScene(metadata(url), scene) : { scene, parser: { json: metadata(url) } };
  });
  return { ...source, loader: new LodLoader(source.manager) };
}

/** Source metadata as a GLTS scene or a glTF parser reports it, resolving `resources`. */
function metadata(type: string, url: string, resources: string[]) {
  return type === "glts"
    ? { url: location.origin + url, dependencyUrls: resources, packages: ["terrain-generator"], runtimeModules: [] }
    : { buffers: [{ uri: resources[0] }, { uri: "data:application/octet-stream;base64,AA==" }], images: [{ uri: resources[1] }, { bufferView: 0 }] };
}

describe("asset cache provenance", () => {
  it.each(["glts", "gltf", "glb"])("discovers %s dependencies with portable, query-preserving identities", async (type) => {
    const url = script.replace(".glts", `.${type}`),
      resolved = canonical.replace(".glts", type === "glts" ? ".glts" : ".png");
    const resources = type === "glts" ? [location.origin + "/helper.bin?shape=oak", resolved] : ["/helper.bin?shape=oak", resolved];
    const { loader } = fixture(() => metadata(type, url, resources), type);
    await loader.loadAsync(url);
    const saved = cache.saved.find((entry) => entry.options.dependencies?.source);
    expect(saved?.options.dependencies).toMatchObject({ source: { url }, "lod:queries": { value: { source: "?seed=2&variant=a/b" } } });
    expect(saved?.dependencies).toEqual({
      "resource:0": { url: "/helper.bin?shape=oak" },
      "resource:1": { url: resolved },
      ...(type === "glts" ? { "package:terrain-generator": { package: "terrain-generator" } } : {}),
    });
  });

  // Each case loads its own URL: LodLoader stops saving a URL for the session once it warned about it.
  it.each([
    { name: "a glts source with a cross-origin resource", type: "glts", url: "/models/remote.glts", resources: [helper, remote] },
    { name: "a gltf source with a cross-origin resource", type: "gltf", url: "/models/remote.gltf", resources: [helper, remote] },
    { name: "a cross-origin source", type: "gltf", url: "https://cdn.test/tree.gltf", resources: [] },
    { name: "a saved dependency without a backing file", type: "glts", url: "/models/api.glts", resources: ["/api/terrain"], missing: "/api/terrain" },
    { name: "an uninstalled key package", type: "glts", url: "/models/keyed.glts", resources: [], missing: "@drawcall/lod" },
  ])("serves $name uncached, with one warning", async ({ type, url, resources, missing }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    if (missing) cache.missing.add(missing);
    const { loader, load } = fixture(() => metadata(type, url, resources), type);
    await loader.loadAsync(url);
    const attempts = cache.attempts;
    await loader.loadAsync(url);
    expect(cache.attempts).toBe(attempts);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.saved.filter((entry) => entry.options.dependencies?.source)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("saves the dependencies a GLTS source reports while its levels are built", async () => {
    const urls = [helper];
    const { loader } = fixture((url) => ({
      url,
      get dependencyUrls() {
        return [...urls];
      },
      packages: [],
      runtimeModules: [],
    }));
    vi.mocked(bakeImpostor).mockImplementationOnce(async () => {
      urls.push("/models/late.bin");
      return baked;
    });
    await loader.loadAsync(script);
    expect(cache.saved.find((entry) => entry.options.dependencies?.source)?.dependencies).toEqual({
      "resource:0": { url: helper },
      "resource:1": { url: "/models/late.bin" },
    });
  });

  it("ignores the query a script's source URL carries", async () => {
    const key = async (query: string) => {
      cache.saved.length = 0;
      cache.files.clear();
      const url = script.replace(/\?.*/, query);
      const { loader } = fixture(() => ({ url, dependencyUrls: [helper], packages: [], runtimeModules: [] }));
      await loader.loadAsync(script);
      return cache.saved[0];
    };
    const requested = await key("?seed=2&variant=a/b");
    expect(requested?.options.dependencies).toMatchObject({ source: { url: script }, "lod:queries": { value: { source: "?seed=2&variant=a/b" } } });
    expect(requested?.dependencies).toEqual({ "resource:0": { url: helper } });
    expect(await key("?seed=1")).toEqual(requested);
  });

  it.each([helper, "terrain-generator"])("invalidates a derived index when dependency %s changes", async (dependency) => {
    const { manager, load } = fixture((url) => ({ url, dependencyUrls: [helper], packages: ["terrain-generator"], runtimeModules: [] }));
    const loader = new LodLoader(manager);
    await loader.loadAsync(script);
    cache.loaded.length = 0;
    await loader.loadAsync(script);
    expect(cache.loaded).toEqual([{ role: "index", hit: true }]);
    expect(load).toHaveBeenCalledOnce();
    cache.versions.set(dependency, "changed");
    await loader.loadAsync(script);
    expect(load).toHaveBeenCalledTimes(2);
    expect(bakeImpostor).toHaveBeenCalledTimes(2);
  });

  it.each(["changed", "unavailable"])("rejects a warm index when its remote generator identity is %s", async (identity) => {
    const modules: Record<string, string> = { "https://cdn.test/generator@1": "first" };
    const { loader, handler, load } = fixture((url) => ({ url, dependencyUrls: [], packages: [], runtimeModules: [] }));
    Object.assign(handler, { moduleSources: { "generator@1": { moduleHashes: modules } } });
    await loader.loadAsync(script);
    await loader.loadAsync(script);
    expect(load).toHaveBeenCalledOnce();
    if (identity === "unavailable") Reflect.deleteProperty(handler, "moduleSources");
    else Object.assign(handler, { moduleSources: { "generator@1": { moduleHashes: { "https://cdn.test/generator@1": "changed" } } } });
    await loader.loadAsync(script);
    expect(load).toHaveBeenCalledTimes(2);
    expect(bakeImpostor).toHaveBeenCalledTimes(2);
  });

  it("does not save levels of a source that fetched runtime modules", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loader } = fixture((url) => ({ url, dependencyUrls: [], packages: [], runtimeModules: ["https://cdn.test/generator@1"] }));
    await loader.loadAsync("/models/runtime.glts");
    expect(cache.saved).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("CDN modules"));
    warn.mockRestore();
  });

  it("rejects a .glts handler that does not load a GLTS scene", async () => {
    const { manager } = sourceFixture(() => house());
    await expect(new LodLoader(manager).loadAsync(script)).rejects.toThrow("did not load as a GLTS scene");
    expect(cache.saved).toHaveLength(0);
    expect(bakeImpostor).not.toHaveBeenCalled();
  });

  it("marks a CDN-only generator as uncacheable without requiring an installed package", async () => {
    const url = new URL("./cdn.glts", import.meta.url).href;
    const manager = new LoadingManager();
    const fetch = globalThis.fetch;
    const content = 'export const value = "first";';
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("https://cdn.test/") ? Promise.resolve(new Response(content)) : fetch(input, init),
    );
    const loader = new GLTSLoader(manager, { cdnURL: "https://cdn.test/" });
    try {
      const scene = await loader.loadAsync(url);
      const provenance = new Provenance({ source: url }, manager);
      provenance.capture(url, scene, scene);
      expect(provenance.dependencies()).toEqual({ reason: expect.stringContaining("CDN modules") });
    } finally {
      loader.dispose();
      vi.unstubAllGlobals();
    }
  });
});

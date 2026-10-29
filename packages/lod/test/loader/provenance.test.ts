import { BoxGeometry, Group, Loader, LoadingManager, Mesh, MeshStandardMaterial } from "three/webgpu";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheEntryOptions } from "vitecache";
import { bakeImpostor } from "../../src/impostor/bake/index.js";
import type { Impostor } from "../../src/impostor/impostor.js";
import { LodLoader, type LodRequest } from "../../src/loader.js";

const cache = vi.hoisted(
  (): {
    files: Map<string, Uint8Array>;
    loaded: Array<{ role: string; hit: boolean }>;
    saved: Array<{ role: string; options: CacheEntryOptions }>;
  } => ({ files: new Map(), loaded: [], saved: [] }),
);

vi.mock("vitecache", () => ({
  CacheEntry: class {
    private readonly key: string;
    private readonly role: string;
    constructor(private readonly options: CacheEntryOptions) {
      this.key = JSON.stringify(options);
      const role = options.dependencies?.["lod:role"]?.value;
      if (typeof role !== "string") throw new Error("Expected a cache role");
      this.role = role;
    }
    async load() {
      const bytes = cache.files.get(this.key);
      cache.loaded.push({ role: this.role, hit: bytes !== undefined });
      return bytes;
    }
    async save(bytes: Uint8Array) {
      cache.saved.push({ role: this.role, options: this.options });
      cache.files.set(this.key, bytes);
    }
  },
}));

vi.mock("../../src/impostor/bake/index.js", async (original) => {
  const module = await original<typeof import("../../src/impostor/bake/index.js")>();
  return { ...module, bakeImpostor: vi.fn(module.bakeImpostor) };
});

const baked: Impostor = {
  version: 3,
  layout: "full",
  frames: 2,
  size: 2,
  box: [-1, -1, -1, 1, 1, 1],
  halfSize: 2,
  maps: ["base", "normalDepth", "orm"],
  layers: Array.from({ length: 3 }, () => [new Uint8Array(16)]),
};
const script = "https://models.test/tree.glts?seed=2";
const canonical = "https://models.test/resolved/tree.glts?seed=2";
const helper = "https://models.test/helper.ts?shape=oak";
const extra = "https://models.test/leaf.ts?size=small";
const model = () => new Group().add(new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial()));

function fixture(source: (url: string) => unknown) {
  const manager = new LoadingManager();
  const handler = new Loader<Group>();
  const load = vi.fn(async (url: string) => Object.assign(model(), { source: source(url) }));
  handler.loadAsync = load;
  manager.addHandler(/\.glts(?:\?|$)/, handler);
  return { manager, load, loader: () => new LodLoader(manager) };
}

beforeEach(() => {
  cache.files.clear();
  cache.loaded.length = cache.saved.length = 0;
  vi.mocked(bakeImpostor).mockReset().mockResolvedValue(baked);
});

describe("GLTS cache provenance", () => {
  it("discovers provenance once, retains query inputs, and fetches source detail only on demand", async () => {
    const { loader, load } = fixture(() => ({ url: canonical, dependencyUrls: [helper] }));
    await loader().loadAsync(script);
    expect(load).toHaveBeenCalledExactlyOnceWith(script);
    expect(cache.saved.map(({ role }) => role)).toEqual(["index", "dependencies"]);
    const index = cache.saved.find(({ role }) => role === "index");
    expect(index?.options.dependencies).toMatchObject({
      source: { url: script },
      "glts:0:source": { url: canonical },
      "glts:0:dependency:0": { url: helper },
      "lod:queries": { value: { source: "?seed=2", "glts:0:source": "?seed=2", "glts:0:dependency:0": "?shape=oak" } },
    });
    cache.loaded.length = 0;
    const warm = await loader().loadAsync(script);
    expect(cache.loaded).toEqual([
      { role: "dependencies", hit: true },
      { role: "index", hit: true },
    ]);
    expect(load).toHaveBeenCalledOnce();
    expect(bakeImpostor).toHaveBeenCalledOnce();
    const source = warm[0];
    if (!source?.load) throw new Error("Expected deferred source");
    await source.load();
    expect(cache.loaded.at(-1)).toEqual({ role: "index", hit: true });
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.saved).toHaveLength(2);
  });

  it("tracks auxiliary scripts and their imported files without executing them on a warm load", async () => {
    const low = "https://models.test/low.glts?ratio=0.1";
    const { loader, load } = fixture((url) => ({ url, dependencyUrls: [url === low ? extra : helper] }));
    const request: LodRequest = {
      url: script,
      levels: [{ type: "baked", low: "low.glts?ratio=0.1", textureSize: 16, maxPixels: 100 }],
    };
    await loader().loadAsync(request);
    expect(load.mock.calls.map(([url]) => url)).toEqual([script, low]);
    const index = cache.saved.find(({ role }) => role === "index");
    expect(index?.options.dependencies).toMatchObject({
      "auxiliary:0:low": { url: low },
      "glts:0:dependency:0": { url: helper },
      "glts:1:source": { url: low },
      "glts:1:dependency:0": { url: extra },
      "lod:queries": { value: { "auxiliary:0:low": "?ratio=0.1", "glts:1:source": "?ratio=0.1", "glts:1:dependency:0": "?size=small" } },
    });
    cache.loaded.length = 0;
    await loader().loadAsync(request);
    expect(cache.loaded).toEqual([
      { role: "dependencies", hit: true },
      { role: "dependencies", hit: true },
      { role: "index", hit: true },
    ]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, { url: canonical }, { url: canonical, dependencyUrls: [42] }])("rejects missing or malformed source metadata: %j", async (source) => {
    const { loader } = fixture(() => source);
    await expect(loader().loadAsync(script)).rejects.toThrow(/GLTS|provenance|metadata/);
    expect(cache.saved).toHaveLength(0);
    expect(bakeImpostor).not.toHaveBeenCalled();
  });
});

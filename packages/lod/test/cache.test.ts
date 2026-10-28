import { GLTSLoader } from "@drawcall/glts";
import { LoadingManager } from "three/webgpu";
import { expect, it, vi } from "vitest";
import * as lod from "../src/index.js";

it("persists a whole GLTS asset after its execution ends, for both object and URL inputs", async () => {
  const fetches = vi.spyOn(globalThis, "fetch");
  const manager = new LoadingManager();
  const scripts = new GLTSLoader(manager, { modules: { "@drawcall/lod": lod } });
  manager.addHandler(/\.glts(?:\?|$)/, scripts);
  const loader = new lod.LodLoader(manager);
  const query = `?run=${crypto.randomUUID()}`;
  const writes = () => fetches.mock.calls.filter(([url, options]) => String(url).includes("/_vitecache/") && options?.method === "PUT");
  try {
    for (const input of ["object", "scene"]) {
      const url = new URL(`/cache/${input}.glts${query}`, location.href).href;
      const load = async () => {
        if (input === "scene")
          return loader.loadAsync({ url, levels: [{ type: "impostor", lazy: true, maxPixels: 32, frames: 2, resolution: 8, supersample: 1 }] });
        const scene = await scripts.loadAsync(url);
        const result = scene.children[0];
        if (!(result instanceof lod.Lod)) throw new Error("GLTS did not construct a Lod");
        expect(scene.source.dependencyUrls.some((dependency) => dependency.endsWith("/cache/shape.ts"))).toBe(true);
        return result;
      };
      const first = await load();
      const level = first.levels[1]?.object;
      if (!(level instanceof lod.LazyImpostor)) throw new Error("Expected an unloaded impostor");
      expect(level.status).toBe("idle");
      const before = writes().length;
      const original = await level.load();
      expect(writes()).toHaveLength(before + 1);
      const second = await load();
      const cached = second.levels[1]?.object;
      if (!(cached instanceof lod.LazyImpostor)) throw new Error("Expected a second unloaded impostor");
      const restored = await cached.load();
      expect(writes()).toHaveLength(before + 1);
      expect(restored).toEqual(original);
      expect(restored).not.toBe(original);
      if (input === "scene") {
        first.dispose();
        second.dispose();
      }
    }
  } finally {
    scripts.dispose();
    fetches.mockRestore();
  }
}, 120_000);

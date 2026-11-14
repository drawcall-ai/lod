import { sourceFixture, gltsScene } from "./fixture.js";
import { expect, it, vi } from "vitest";
import { BoxGeometry, LoadingManager, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene } from "three/webgpu";
import { Lod } from "../../src/lod.js";
import { CachedLodLoader } from "../../src/loader/index.js";
import { GPU_TIMEOUT, nextLevel } from "../renderer.js";
import type { LodRequest } from "../../src/loader/request.js";

vi.mock("vitecache", async () => ({ CacheEntry: (await import("./fixture.js")).CacheEntry }));
vi.mock("../../src/impostor/bake/index.js", async () => ({ bakeImpostor: (await import("./fixture.js")).bakeImpostor }));

it("never loads the source of a ladder whose first level draws at any height, with the camera inside it too", { timeout: GPU_TIMEOUT }, async () => {
  const built = sourceFixture(() => gltsScene(new Mesh(new BoxGeometry(), new MeshStandardMaterial())), /\.glts$/);
  const request: LodRequest = {
    url: "/far.glts",
    levels: [
      { type: "impostor", maxPixels: Infinity },
      { type: "empty", maxPixels: 2 },
    ],
  };
  await (await new CachedLodLoader(built.manager).loadAsync(request))[1]?.load?.();
  const levels = await new CachedLodLoader(new LoadingManager()).loadAsync(request);
  expect(levels.map((level) => level.maxPixels)).toEqual([Infinity, Infinity, 2]);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const lods = [1, 3].map((count) => new Lod(levels, count));
  try {
    for (const lod of lods) {
      lod.position.z = -0.1;
      new Scene().add(lod);
      await nextLevel(lod, camera);
      expect(lod.levels.map(({ object }) => object !== undefined)).toEqual([false, true, true]);
      expect(lod.getLevelAt(0, camera)).toBe(1);
    }
  } finally {
    for (const lod of lods) lod.dispose();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three/webgpu";
import { loadManifest, textureFile, texturesReady, restoreSurface } from "../../src/content/materials.ts";

test("atlas metadata neither fetches pixels nor poisons the rendered surface cache", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ models: {}, textures: { atlas: { diff: "base.png", nor: "normal.png", arm: "arm.png", size: [2, 4] } }, hdri: {} }),
  );
  await loadManifest();
  const images = t.mock.method(THREE.ImageBitmapLoader.prototype, "loadAsync", async () => ({ width: 1, height: 1 }));
  const recipe = { surface: { id: "atlas", options: {} } };
  const row = restoreSurface("atlas", recipe, "metadata");
  assert.ok(row?.map);
  assert.equal(images.mock.callCount(), 0);
  const rendered = restoreSurface("atlas", recipe);
  assert.ok(rendered?.map);
  await texturesReady([rendered]);
  assert.equal(images.mock.callCount(), 3);
  assert.equal(row.map.image, null);
  assert.equal(textureFile(row.map), textureFile(rendered.map));
  assert.equal(restoreSurface("atlas", recipe, "metadata")?.map?.image, null);
});

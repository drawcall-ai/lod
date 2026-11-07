import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheEntry } from "vitecache";
import { BoxGeometry, LoadingManager, Mesh, MeshStandardNodeMaterial } from "three/webgpu";
import { cachedObject } from "../../public/content/object.ts";
import { Library } from "../../public/content/materials.ts";

test("cached geometry reuses explicit stable library keys without serializing material recipes", async (t) => {
  let bytes: Uint8Array | undefined;
  t.mock.method(CacheEntry.prototype, "load", async () => bytes);
  t.mock.method(CacheEntry.prototype, "save", async (value: Uint8Array) => {
    bytes = value;
  });
  const cold = new Library(new LoadingManager(), "https://assets.test/"),
    warm = new Library(new LoadingManager(), "https://assets.test/");
  const makeMaterial = () => new MeshStandardNodeMaterial({ name: "leaf" });
  const source = new Mesh(new BoxGeometry(), cold.material("corn:leaf", makeMaterial));
  const material = warm.material("corn:leaf", makeMaterial);
  const make = t.mock.fn(() => source);
  await cachedObject(new CacheEntry({ version: "test" }), cold, [source.material], make);
  const restored = await cachedObject(new CacheEntry({ version: "test" }), warm, [material], make);
  assert.equal(make.mock.callCount(), 1);
  assert.ok(restored instanceof Mesh);
  assert.equal(restored.material, material);
  assert.deepEqual(restored.geometry.getAttribute("position").array, source.geometry.getAttribute("position").array);
  cold.dispose();
  warm.dispose();
});

test("missing asset material registration fails on the cold build", async (t) => {
  t.mock.method(CacheEntry.prototype, "load", async () => undefined);
  const library = new Library(new LoadingManager(), "https://assets.test/");
  await assert.rejects(
    cachedObject(
      new CacheEntry({ version: "test" }),
      library,
      [],
      () =>
        new Mesh(
          new BoxGeometry(),
          library.material("forgotten", () => new MeshStandardNodeMaterial()),
        ),
    ),
    /Asset did not register material forgotten/,
  );
  library.dispose();
});

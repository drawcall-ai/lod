import assert from "node:assert/strict";
import { test } from "node:test";
import { FileLoader, LoadingManager, MeshStandardMaterial } from "three/webgpu";
import { Library } from "../../public/content/materials.ts";
import { Textures } from "../../public/content/textures.ts";

test("asset libraries share one decoded texture until its host disposes it", async (t) => {
  const textures = new Textures();
  const first = new Library(new LoadingManager(), "https://assets.test/", textures),
    second = new Library(new LoadingManager(), "https://assets.test/", textures);
  const data = {
    models: {},
    textures: {
      leaf: { diff: "shared-leaf.png", nor: "", arm: "", size: [1, 1], bytes: 1, credit: { name: "leaf", authors: [], license: "CC0-1.0", source: "" } },
    },
    hdri: { file: "", credit: { name: "sky", authors: [], license: "CC0-1.0", source: "" } },
  };
  t.mock.method(FileLoader.prototype, "loadAsync", async () => data);
  await Promise.all([first.load(), second.load()]);
  const bitmap = { width: 1, height: 1, close: t.mock.fn() };
  let finishDecode: ((image: typeof bitmap) => void) | undefined;
  const decoded = new Promise<typeof bitmap>((resolve) => (finishDecode = resolve));
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array([1])));
  const previous = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  const decode = t.mock.fn(() => decoded);
  Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: decode });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "createImageBitmap", previous);
    else Reflect.deleteProperty(globalThis, "createImageBitmap");
  });
  const textureA = first.texture("leaf", "diff"),
    textureB = second.texture("leaf", "diff");
  assert.equal(textureA.image, null);
  assert.equal(textureA, textureB);
  assert.ok(finishDecode);
  finishDecode(bitmap);
  await Promise.all([first.ready(), second.ready()]);
  assert.equal(decode.mock.callCount(), 1);
  assert.equal(textureA.image, bitmap);
  first.material("leaf", () => new MeshStandardMaterial({ map: textureA }));
  second.material("leaf", () => new MeshStandardMaterial({ map: textureB }));
  const disposedMap = t.mock.method(textureA, "dispose");
  first.dispose();
  second.dispose();
  assert.equal(disposedMap.mock.callCount(), 0);
  assert.equal(bitmap.close.mock.callCount(), 0);
  textures.dispose();
  assert.equal(disposedMap.mock.callCount(), 1);
  assert.equal(bitmap.close.mock.callCount(), 1);
});

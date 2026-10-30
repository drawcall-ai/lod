import assert from "node:assert/strict";
import { test } from "node:test";
import { ImageBitmapLoader, LoadingManager, SRGBColorSpace } from "three/webgpu";
import { Textures } from "../../public/content/textures.ts";

test("failed textures reject existing borrowers and allow an explicit retry", async (t) => {
  const textures = new Textures();
  const manager = new LoadingManager();
  const failure = new Error("Image unavailable");
  const bitmap = { width: 1, height: 1, close: t.mock.fn() };
  let requests = 0;
  t.mock.method(ImageBitmapLoader.prototype, "loadAsync", async () => {
    if (++requests === 1) throw failure;
    return bitmap;
  });
  const load = () => textures.load("https://assets.test/leaf.png", [1, 1], SRGBColorSpace, manager);
  const first = load();
  const borrower = load();
  const dispose = t.mock.method(first, "dispose");
  assert.equal(first, borrower);
  await assert.rejects(textures.ready([first]), (error) => error === failure);
  await assert.rejects(textures.ready([borrower]), (error) => error === failure);
  assert.equal(dispose.mock.callCount(), 1);
  const retry = load();
  assert.notEqual(retry, first);
  await textures.ready([retry]);
  assert.equal(requests, 2);
  assert.equal(retry.image, bitmap);
  textures.dispose();
  assert.equal(dispose.mock.callCount(), 1);
  assert.equal(bitmap.close.mock.callCount(), 1);
});

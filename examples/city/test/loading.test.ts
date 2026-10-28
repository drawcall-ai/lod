import assert from "node:assert/strict";
import { test } from "node:test";
import { DefaultLoadingManager } from "three/webgpu";
import { downloaded } from "../src/loading.ts";

test("readiness waits for decoded images and reports failed assets", async () => {
  DefaultLoadingManager.itemStart("texture.webp");
  let ready = false;
  const pending = downloaded().then(() => (ready = true));
  await Promise.resolve();
  assert.equal(ready, false);
  // ImageBitmapLoader ends the item only after decode and its texture callback.
  DefaultLoadingManager.itemEnd("texture.webp");
  await pending;
  assert.equal(ready, true);

  DefaultLoadingManager.itemStart("broken.webp");
  DefaultLoadingManager.itemError("broken.webp");
  DefaultLoadingManager.itemEnd("broken.webp");
  await assert.rejects(downloaded(), /Unable to load assets: broken\.webp/);
});

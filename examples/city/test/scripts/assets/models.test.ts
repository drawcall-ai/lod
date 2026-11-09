import assert from "node:assert/strict";
import { test } from "node:test";
import { Document } from "@gltf-transform/core";
import sharp from "sharp";
import { fillCutOuts } from "../../../scripts/assets/models.ts";

test("a cut-out's transparent texels take its kept texels' mean colour and stay transparent", async () => {
  const raw = { width: 3, height: 1, channels: 4 } as const;
  const leaves = [40, 200, 10, 255, 60, 100, 30, 255];
  const image = await sharp(Buffer.from([...leaves, 0, 0, 0, 0]), { raw })
    .png()
    .toBuffer();
  const doc = new Document();
  const texture = doc.createTexture("leaf").setMimeType("image/webp").setImage(new Uint8Array(image));
  doc.createMaterial().setBaseColorTexture(texture).setAlphaMode("MASK");

  await fillCutOuts(doc);

  const result = texture.getImage();
  if (!result) throw new Error("the filled texture has no image");
  const filled = await sharp(result).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...filled], [...leaves, 50, 150, 20, 0]);
  assert.equal(texture.getMimeType(), "image/png");
});

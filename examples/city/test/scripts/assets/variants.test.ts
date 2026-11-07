import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Document, NodeIO } from "@gltf-transform/core";
import { getBounds } from "@gltf-transform/functions";
import { variant, writeVariant } from "../../../scripts/assets/variants.ts";

test("written variants preserve encoded images and authored placement, batching static prop parts", async (t) => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const image = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1zYAAAAASUVORK5CYII=", "base64"));
  const texture = doc.createTexture("leaf").setMimeType("image/png").setImage(image);
  const material = doc.createMaterial().setBaseColorTexture(texture).setAlphaMode("MASK");
  const positions = doc
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 1]))
    .setBuffer(buffer);
  const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute("POSITION", positions).setMaterial(material));
  const parent = doc.createNode().setTranslation([7, 3, -4]).setScale([2, 1, 0.5]);
  parent.addChild(doc.createNode("a").setMesh(mesh));
  parent.addChild(doc.createNode("b").setMesh(mesh).setTranslation([2, 0, 0]));
  parent.addChild(doc.createNode("unused").setMesh(mesh).setTranslation([100, 0, 0]));
  doc.createScene().addChild(parent);

  const io = new NodeIO();
  const directory = await mkdtemp(join(tmpdir(), "city-variants-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "images"));
  const shared = new Set<string>();
  for (const batch of [false, true]) {
    const output = await writeVariant(io, await variant(doc, "prop", ["a", "b"], batch));
    for (const [uri, bytes] of output.images) {
      shared.add(uri);
      await writeFile(join(directory, uri), bytes);
      assert.deepEqual(bytes, image);
    }
    const path = join(directory, `prop-${batch}.glb`);
    await writeFile(path, output.binary);
    const json = await io.readAsJSON(path);
    assert.ok(json.json.images?.every((image) => image.uri?.startsWith("images/") && image.bufferView === undefined));
    const written = await io.readJSON(json);
    const scene = written.getRoot().getDefaultScene();
    assert.ok(scene);
    assert.deepEqual(getBounds(scene), { min: [-3, 3, -0.25], max: [3, 4, 0.25] });
    assert.equal(
      written
        .getRoot()
        .listNodes()
        .some((node) => node.getName() === "unused"),
      false,
    );
    assert.equal(scene.listChildren().length, batch ? 1 : 2);
    assert.deepEqual(
      written
        .getRoot()
        .listTextures()
        .map((texture) => {
          const encoded = texture.getImage();
          assert.ok(encoded);
          return [...encoded];
        }),
      [[...image]],
    );
    assert.equal(written.getRoot().listMaterials()[0]?.getAlphaMode(), "MASK");
  }
  assert.equal(shared.size, 1);
});

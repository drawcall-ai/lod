import assert from "node:assert/strict";
import { test } from "node:test";
import { DataTexture, Mesh, MeshStandardMaterial, PlaneGeometry } from "three/webgpu";
import { Foliage, foliageModel } from "../../public/shared/foliage.ts";

test("cutout foliage keeps its alpha threshold and coverage through conversion and cloning", () => {
  const map = new DataTexture(new Uint8Array([90, 120, 40, 255]), 1, 1);
  const source = new MeshStandardMaterial({ map, alphaTest: 0.5 });
  const tree = new Mesh(new PlaneGeometry(), source);
  foliageModel(tree, { translucency: 0.6 });
  assert.ok(tree.material instanceof Foliage);
  const clone = tree.material.clone();
  for (const material of [tree.material, clone]) {
    assert.equal(material.alphaTest, 0.5);
    assert.equal(material.alphaToCoverage, true);
    assert.ok(material.opacityNode);
    assert.ok(material.colorNode);
    assert.equal(material.translucency, 0.6);
    material.dispose();
  }
  source.dispose();
  tree.geometry.dispose();
  map.dispose();
});

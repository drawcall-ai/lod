import assert from "node:assert/strict";
import { test } from "node:test";
import { InstancedLod } from "@drawcall/lod";
import { BoxGeometry, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera } from "three/webgpu";
import { Patches, type Tiles } from "../../src/world/patches.ts";

test("a tile the camera moved on from gives its chunk back to the tile that replaces it", () => {
  const lod = new InstancedLod([{ object: new Mesh(new BoxGeometry(), new MeshBasicMaterial()) }]);
  let nearby = [2];
  const matrix = new Matrix4();
  const tiles: Tiles = {
    near: (_, __, visit) => nearby.forEach((tile) => visit(tile, 0)),
    fill: (tile, emit) => {
      for (let i = 0; i < tile; i++) emit(0, matrix.makeTranslation(tile, 0, 0));
    },
  };
  const patches = new Patches([lod], 1, tiles, () => 100);
  const update = () => {
    patches.update(new PerspectiveCamera());
  };
  update();
  assert.equal(lod.count, 2);
  nearby = [1];
  update();
  assert.equal(lod.count, 1);
  const [chunk] = lod.chunks;
  assert.ok(chunk);
  assert.equal(lod.getMatrixAt(chunk.start, matrix).elements[12], 1);
  nearby = [];
  update();
  assert.equal(lod.chunks.size, 0);
  lod.dispose();
});

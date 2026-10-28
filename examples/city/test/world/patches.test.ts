import assert from "node:assert/strict";
import { test } from "node:test";
import { InstancedLod } from "@drawcall/lod";
import { BoxGeometry, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera } from "three/webgpu";
import { Patches, type Tiles } from "../../src/world/patches.ts";

test("reusing a patch chunk parks the instances its replacement leaves empty", () => {
  const lod = new InstancedLod([new Mesh(new BoxGeometry(), new MeshBasicMaterial())], 2);
  let nearby = [2];
  const matrix = new Matrix4();
  const tiles: Tiles = {
    near: (_, __, visit) => nearby.forEach((tile) => visit(tile, 0)),
    fill: (tile, emit) => {
      for (let i = 0; i < tile; i++) emit(0, matrix.makeTranslation(tile, 0, 0));
    },
  };
  const patches = new Patches([lod], [2], 1, tiles, () => 100);
  const update = () => {
    Patches.beginFrame();
    patches.update(new PerspectiveCamera());
  };
  update();
  nearby = [1];
  update();
  lod.getMatrixAt(0, matrix);
  assert.equal(matrix.elements[12], 1);
  lod.getMatrixAt(1, matrix);
  assert.equal(matrix.determinant(), 0);
  lod.dispose();
});

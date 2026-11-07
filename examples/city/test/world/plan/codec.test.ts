import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { BufferGeometry, MeshBasicMaterial } from "three/webgpu";
import { plan } from "../../../src/world/plan.ts";
import { decode, encode } from "../../../src/world/plan/codec.ts";
import { roadShapes } from "../../../src/world/roads.ts";

test("cached plans preserve placements and geometry without warm generation", async (t) => {
  const original = plan(7);
  const files = await encode(original);
  t.mock.method(BufferGeometry.prototype, "computeVertexNormals", () => {
    throw new Error("Warm plan regenerated its geometry");
  });
  const restored = await decode(files);
  assert.deepEqual(restored, original);
  const shapes = (world: typeof original) => {
    const geometries = [world.terrain.mesh(new MeshBasicMaterial()).geometry, ...Object.values(roadShapes(world))];
    return geometries.map(({ index, attributes, boundingBox }) => [index?.array, Object.values(attributes).map(({ array }) => array), boundingBox]);
  };
  assert.ok(isDeepStrictEqual(shapes(restored), shapes(original)), "Cached terrain and road geometry differs");
});

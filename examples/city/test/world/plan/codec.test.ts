import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { BufferGeometry, MeshBasicMaterial } from "three/webgpu";
import { plan } from "../../../src/world/plan.ts";
import { decode, encode } from "../../../src/world/plan/codec.ts";
import { roadShapes } from "../../../src/world/roads.ts";

const shape = ({ index, attributes, boundingBox }: BufferGeometry) => [index?.array, Object.values(attributes).map(({ array }) => array), boundingBox];

test("cached plans preserve placements and road geometry without warm generation, and draw the planned ground", async (t) => {
  const original = plan(7);
  const files = await encode(original);
  const regenerated = t.mock.method(BufferGeometry.prototype, "computeVertexNormals", () => {
    throw new Error("Warm plan regenerated its road geometry");
  });
  const restored = await decode(files);
  assert.deepEqual(restored, original);
  const roads = (world: typeof original) => Object.values(roadShapes(world)).map(shape);
  assert.ok(isDeepStrictEqual(roads(restored), roads(original)), "Cached road geometry differs");
  regenerated.mock.restore();
  const ground = (world: typeof original) => shape(world.terrain.mesh(new MeshBasicMaterial()).geometry);
  assert.ok(isDeepStrictEqual(ground(restored), ground(original)), "The cached heights draw other ground");
});

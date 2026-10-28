import assert from "node:assert/strict";
import { test } from "node:test";
import { plan } from "../src/world/plan.ts";
import { decode, encode } from "../src/world/plan/codec.ts";

test("cached plan preserves placements, terrain and land exactly", () => {
  const original = plan(7);
  const files = encode(original);
  const restored = decode(files);
  assert.deepEqual(restored, original);
  for (const [x, z] of [
    [0, 0],
    [-914.7, -560.3],
    [432.1, 713.5],
  ] as const) {
    assert.equal(restored.terrain.height(x, z), original.terrain.height(x, z));
    assert.equal(restored.land.at(x, z), original.land.at(x, z));
  }
  assert.throws(() => decode({ ...files, heights: files.heights.subarray(4) }), /heightfield/);
  assert.throws(() => decode({ ...files, cells: new Uint8Array(files.cells.length).fill(255) }), /land raster/);
  assert.throws(() => decode({ ...files, layout: new TextEncoder().encode('{"roads":null}') }), /plan/);
});

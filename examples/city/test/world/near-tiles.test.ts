import assert from "node:assert/strict";
import { test } from "node:test";
import type { LodCluster } from "@drawcall/lod";
import { Box3, Vector3 } from "three/webgpu";
import { NearTiles, tileAt, tileKey, tilesAround } from "../../src/world/near-tiles.ts";

const TILE = 6;

test("tiles near the camera fill a budget per update, nearest first, each in a slot, and leave once out of reach", () => {
  const clusters: LodCluster[] = [];
  const radius = 2 * TILE;
  const capacity = 10;
  const perFrame = 4;
  const empty = tileKey(1, 1);
  const filled: [tile: number, slot: number][] = [];
  const tiles = new NearTiles({
    near: (eye) => tilesAround(eye, eye.y, { radius, tile: TILE, holds: (key) => key !== empty }),
    fill: (tile, slot) => {
      filled.push([tile, slot]);
      return [{ clusters, cluster: { start: slot * capacity, count: capacity, boundingBox: new Box3() } }];
    },
    perFrame,
    room: 25,
  });
  const eye = new Vector3(TILE / 2, 0, TILE / 2);
  tiles.update(eye);
  const [first] = filled;
  assert.ok(first);
  assert.deepEqual(tileAt(first[0]), [0, 0], "the camera's own tile first");
  assert.deepEqual(
    clusters.map(({ start }) => start),
    [0, 10, 20, 30],
    "each tile in a slot of its own",
  );
  for (let frame = 0; frame < 20; frame++) tiles.update(eye);
  // The tiles out to radius / TILE tiles away, less the block's corners (1.5 √2 tiles away) and the empty tile.
  const reach = radius / TILE;
  assert.equal(clusters.length, (2 * reach + 1) ** 2 - 4 - 1);
  assert.equal(new Set(clusters.map(({ start }) => start)).size, clusters.length, "no two tiles share a slot");
  assert.ok(tiles.settled);
  assert.ok(!filled.some(([tile]) => tile === empty), "a tile with nothing in it is never filled");
  const count = filled.length;
  tiles.update(eye);
  assert.equal(filled.length, count, "tiles held are not filled again");
  tiles.update(new Vector3(TILE / 2, radius + 1, TILE / 2));
  assert.equal(clusters.length, 0, "out of reach above the ground");
});

test("a tile past the room stays until a nearer one takes its slot", () => {
  const clusters: LodCluster[] = [];
  let nearby = [3, 4];
  const tiles = new NearTiles({
    near: () => nearby.map((tile) => ({ tile, distance: tile })),
    // tile n holds n instances
    fill: (tile, slot) => [{ clusters, cluster: { start: slot * 10, count: tile, boundingBox: new Box3() } }],
    perFrame: 1,
    room: 2,
  });
  const held = () => clusters.map(({ count }) => count).sort();
  const eye = new Vector3();
  tiles.update(eye);
  tiles.update(eye);
  assert.deepEqual(held(), [3, 4]);
  nearby = [1, 2, 3, 4];
  tiles.update(eye);
  assert.deepEqual(held(), [1, 3], "the farthest gives its slot to the nearest");
  assert.ok(!tiles.settled);
  tiles.update(eye);
  assert.deepEqual(held(), [1, 2], "the next stays until its replacement fills");
  assert.ok(tiles.settled);
  nearby = [2];
  tiles.update(eye);
  assert.deepEqual(held(), [2], "out of reach leaves at once");
  nearby = [];
  tiles.update(eye);
  assert.equal(clusters.length, 0);
});

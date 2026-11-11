import assert from "node:assert/strict";
import { test } from "node:test";
import type { InstancedLodCpuChunkParameters } from "@drawcall/lod";
import { InstancedBufferAttribute, Matrix4, Object3D, Vector3 } from "three/webgpu";
import { NearTiles, tileAt, tileKey, tilesAround } from "../../src/world/near-tiles.ts";

const TILE = 6;

/** A chunk as the recorder holds it: its first instance, how many, and its first matrix's x. */
interface Recorded {
  start: number;
  count: number;
  x: number;
}

/** Takes chunks as an InstancedLod does, recording each: Node has no WebGPU to draw them. */
class Recorder extends Object3D {
  readonly chunks = new Set<Recorded>();

  addChunk({ instanceMatrix, start = 0, count = instanceMatrix.count - start }: InstancedLodCpuChunkParameters): Recorded {
    const chunk = { start, count, x: instanceMatrix.array[start * 16 + 12] ?? NaN };
    this.chunks.add(chunk);
    return chunk;
  }

  removeChunk(chunk: Recorded): void {
    assert.ok(this.chunks.delete(chunk), "removes a chunk it holds");
  }
}

const instances = (lod: Recorder) => [...lod.chunks].reduce((sum, { count }) => sum + count, 0);

test("tiles near the camera fill a budget per update, nearest first, and leave once out of reach", () => {
  const lod = new Recorder();
  const radius = 2 * TILE;
  const capacity = 10;
  const perFrame = 4;
  const matrices = new InstancedBufferAttribute(new Float32Array(perFrame * capacity * 16), 16);
  const empty = tileKey(1, 1);
  const filled: [tile: number, slot: number][] = [];
  const tiles = new NearTiles([lod], {
    near: (eye) => tilesAround(eye, eye.y, { radius, tile: TILE, holds: (key) => key !== empty }),
    chunks: (tile, slot) => {
      filled.push([tile, slot]);
      return [{ lod, parameters: { instanceMatrix: matrices, start: slot * capacity, count: capacity } }];
    },
    perFrame,
  });
  const eye = new Vector3(TILE / 2, 0, TILE / 2);
  tiles.update(eye);
  const [first] = filled;
  assert.ok(first);
  assert.deepEqual(tileAt(first[0]), [0, 0], "the camera's own tile first");
  assert.deepEqual(
    filled.map(([, slot]) => slot),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    [...lod.chunks].map(({ start }) => start),
    [0, 10, 20, 30],
  );
  assert.ok(
    [...lod.chunks].every(({ count }) => count === capacity),
    "each tile's chunk holds its slot's instances",
  );
  for (let frame = 0; frame < 20; frame++) tiles.update(eye);
  // The tiles out to radius / TILE tiles away, less the block's corners (1.5 √2 tiles away) and the empty tile.
  const reach = radius / TILE;
  assert.equal([...lod.chunks].length, (2 * reach + 1) ** 2 - 4 - 1);
  assert.ok(tiles.settled);
  assert.ok(!filled.some(([tile]) => tile === empty), "a tile with nothing in it is never filled");
  const count = filled.length;
  tiles.update(eye);
  assert.equal(filled.length, count, "tiles held are not filled again");
  tiles.update(new Vector3(TILE / 2, radius + 1, TILE / 2));
  assert.equal([...lod.chunks].length, 0, "out of reach above the ground");
});

test("a tile past the room stays until a nearer one fills in its place", () => {
  const lod = new Recorder();
  let nearby = [3, 4];
  const matrix = new Matrix4();
  const tiles = new NearTiles([lod], {
    near: () => nearby.map((tile) => ({ tile, distance: tile })),
    // tile n holds n instances, all at x = n
    chunks: (tile) => {
      const matrices = new InstancedBufferAttribute(new Float32Array(tile * 16), 16);
      for (let i = 0; i < tile; i++) matrix.makeTranslation(tile, 0, 0).toArray(matrices.array, i * 16);
      return [{ lod, parameters: { instanceMatrix: matrices } }];
    },
    perFrame: 1,
    room: 2,
  });
  const held = () => [...lod.chunks].map(({ x }) => x).sort();
  const eye = new Vector3();
  tiles.update(eye);
  tiles.update(eye);
  assert.deepEqual(held(), [3, 4]);
  nearby = [1, 2, 3, 4];
  tiles.update(eye);
  assert.deepEqual(held(), [1, 3], "the farthest gives its room to the nearest");
  assert.ok(!tiles.settled);
  tiles.update(eye);
  assert.deepEqual(held(), [1, 2], "the next stays until its replacement fills");
  assert.ok(tiles.settled);
  nearby = [2];
  tiles.update(eye);
  assert.deepEqual(held(), [2], "out of reach leaves at once");
  nearby = [];
  tiles.update(eye);
  assert.equal(instances(lod), 0);
});

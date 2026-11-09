import assert from "node:assert/strict";
import { test } from "node:test";
import type { GpuChunk, GpuChunkData } from "@drawcall/lod";
import { Object3D, Vector3 } from "three/webgpu";
import { SLOTS, Stream, tileKey, type Crowd } from "../../src/world/stream.ts";

const TILE = 6;

/** A crowd without a GPU: only the chunks it holds. */
class Held extends Object3D implements Crowd {
  readonly chunks = new Set<GpuChunk>();

  addGpuChunk(data: GpuChunkData): GpuChunk {
    const chunk = { ...data, slot: this.chunks.size };
    this.chunks.add(chunk);
    return chunk;
  }

  removeGpuChunk(chunk: GpuChunk): void {
    this.chunks.delete(chunk);
  }
}

test("a stream takes the nearest tiles in through its slots, and frees far ones first", () => {
  const lod = new Held();
  const emitted: [number, number, number][] = [];
  const stream = new Stream([lod], {
    radius: 2 * TILE,
    tile: TILE,
    capacity: 10,
    holds: (key) => key !== tileKey(1, 1),
    heightsOver: () => [0, 1],
    emit: (i, j, slot) => emitted.push([i, j, slot]),
  });
  stream.update(new Vector3(TILE / 2, 0, TILE / 2), 0);
  assert.equal(lod.chunks.size, SLOTS);
  assert.deepEqual(emitted[0], [0, 0, 0]);
  assert.deepEqual(emitted.map(([, , slot]) => slot), [0, 1, 2, 3]);
  assert.deepEqual([...lod.chunks].map(({ first, counter }) => [first, counter]), [[0, 0], [10, 1], [20, 2], [30, 3]]);
  for (let frame = 0; frame < 20; frame++) stream.update(new Vector3(TILE / 2, 0, TILE / 2), 0);
  const all = lod.chunks.size;
  assert.ok(all > SLOTS);
  assert.ok(!emitted.some(([i, j]) => i === 1 && j === 1), "a tile where nothing grows is never written");
  const count = emitted.length;
  stream.update(new Vector3(TILE / 2, 0, TILE / 2), 0);
  assert.equal(emitted.length, count, "tiles held are not written again");
  stream.update(new Vector3(TILE / 2, 3 * TILE, TILE / 2), 3 * TILE);
  assert.equal(lod.chunks.size, 0, "out of reach above the ground");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { GLTSLoader } from "@drawcall/glts";
import { Color, InstancedBufferAttribute, LoadingManager, Matrix4, StorageInstancedBufferAttribute } from "three/webgpu";
import { Scatter } from "../../src/world/scatter.ts";

const BOX = new URL("./box.glts", import.meta.url).href;

test("a sealed scatter clusters the copies placed by region, with colours of 3 floats on the CPU and 4 in storage", async () => {
  const loader = new GLTSLoader(new LoadingManager(), { resolve: import.meta.resolve });
  try {
    const scatter = new Scatter(loader);
    const at = (x: number) => ({ matrix: new Matrix4().makeTranslation(x, 0, 0), color: new Color(1, 0, 0) });
    await scatter.place(BOX, [at(1500), at(10), at(1600)]);
    await scatter.take(`${BOX}?computed`, 2, true);
    await scatter.seal();
    // as a frame does, handing each node's instances to its Lod
    scatter.updateMatrixWorld();
    const placed = await scatter.lod(BOX);
    const computed = await scatter.lod(`${BOX}?computed`);
    assert.ok(placed.instanceColor instanceof InstancedBufferAttribute);
    assert.deepEqual(
      placed.clusters?.map(({ start, count }) => [start, count]),
      [
        [0, 1],
        [1, 2],
      ],
      "the copy in region 0 first, then the two in region 1",
    );
    assert.equal(placed.instanceColor.itemSize, 3);
    assert.deepEqual(Array.from(placed.instanceColor.array.slice(0, 3)), [1, 0, 0]);
    assert.ok(computed.instanceColor instanceof StorageInstancedBufferAttribute);
    assert.equal(computed.instanceColor.itemSize, 4);
  } finally {
    loader.dispose();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { ImpostorMesh, InstancedLod } from "@drawcall/lod";
import { Box3, Matrix4, PerspectiveCamera, Vector3 } from "three/webgpu";
import { demand, culledDemand } from "../src/world/trees/demand.ts";
import type { Tree } from "../src/world/trees/data.ts";

test("tree demand is independent of render crowd boundaries", () => {
  const tree: Tree = {
    name: "tree",
    amplitude: 0.025,
    impostor: {
      version: 3,
      layout: "hemi",
      frames: 2,
      size: 4,
      box: [-1, 0, -1, 1, 2, 1],
      halfSize: 2,
      maps: ["base", "normalDepth", "orm"],
      layers: Array.from({ length: 3 }, () => [new Uint8Array(64), new Uint8Array(16)]),
    },
  };
  const source = new ImpostorMesh(tree.impostor);
  const crowds = [new InstancedLod([source], 2), new InstancedLod([source], 2), new InstancedLod([source], 4)];
  const [left, right, merged] = crowds;
  assert.ok(left && right && merged);
  const matrix = new Matrix4();
  for (const [i, x] of [-2010, -2000, 2000, 2010].entries()) {
    matrix.makeTranslation(x, 0, 0);
    merged.setMatrixAt(i, matrix);
    (i < 2 ? left : right).setMatrixAt(i % 2, matrix);
  }
  const separate = demand([left, right], [tree], [source], 100);
  const combined = demand([merged], [tree], [source], 100);
  const absent = culledDemand(
    [-2010, -2000, 2000, 2010].map((x) => ({ x, y: 0, z: 0, scale: 1, angle: 0 })),
    new Box3(new Vector3(-1, 0, -1), new Vector3(1, 2, 1)),
    100,
  );
  const height = Object.getOwnPropertyDescriptor(globalThis, "innerHeight");
  Object.defineProperty(globalThis, "innerHeight", { value: 982, configurable: true });
  try {
    const camera = new PerspectiveCamera(50, 1, 0.1, 10000);
    for (const [x, expected] of [
      [0, false],
      [1900, false],
      [1990, true],
      [-1990, true],
    ] as const) {
      camera.position.set(x, 1, 0);
      camera.updateMatrixWorld(true);
      assert.equal(separate(camera), expected);
      assert.equal(combined(camera), expected);
      assert.equal(absent(camera), expected);
    }
  } finally {
    if (height) Object.defineProperty(globalThis, "innerHeight", height);
    else Reflect.deleteProperty(globalThis, "innerHeight");
    for (const crowd of crowds) crowd.dispose();
  }
});

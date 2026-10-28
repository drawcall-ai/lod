import assert from "node:assert/strict";
import test from "node:test";
import { Group, PerspectiveCamera, Vector3 } from "three/webgpu";
import { Stream, needed } from "../src/world/stream.ts";

test("a family commits once and retires only replaced roots", async () => {
  const far = new Group(),
    retained = new Group(),
    detail = new Group();
  let resolve: (objects: Group[]) => void = () => {
    throw new Error("Factory has not started");
  };
  let builds = 0,
    changes = 0;
  const retired: Group[] = [];
  const family = new Stream(
    "test",
    [far, retained],
    () => {
      builds++;
      return new Promise<Group[]>((done) => {
        resolve = done;
      });
    },
    () => true,
    undefined,
    (old) => {
      for (const object of old) {
        assert.ok(object instanceof Group);
        retired.push(object);
      }
    },
  );
  family.onReady = () => {
    changes++;
  };
  const pending = family.load();
  assert.equal(family.load(), pending);
  assert.equal(family.loading, true);
  assert.equal(family.ready, false);
  assert.deepEqual(family.object.children, [far, retained]);
  resolve([detail, retained]);
  await pending;
  assert.deepEqual(family.object.children, [detail, retained]);
  assert.deepEqual(retired, [far]);
  assert.equal(family.loading, false);
  assert.equal(family.ready, true);
  assert.equal(builds, 1);
  assert.equal(changes, 1);
});

test("a failed source leaves the previous representation attached", async () => {
  const far = new Group();
  const failure = new Error("source unavailable");
  const family = new Stream(
    "test",
    [far],
    async () => {
      throw failure;
    },
    () => true,
  );
  await assert.rejects(family.load(), failure);
  assert.deepEqual(family.object.children, [far]);
  assert.equal(family.ready, false);
  assert.equal(family.loading, false);
});

test("detail demand includes offscreen shadow casters and reacts to view scale", () => {
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
  camera.updateMatrixWorld();
  // Behind the camera, still close enough to cast into the view.
  assert.equal(needed(camera, new Vector3(0, 0, 10), 1, 90, 800), true);
  assert.equal(needed(camera, new Vector3(0, 0, 1000), 1, 90, 800), false);
  assert.equal(needed(camera, new Vector3(0, 0, 30), 1, 90, 800), false);
  assert.equal(needed(camera, new Vector3(0, 0, 30), 1, 90, 1600), true);
});

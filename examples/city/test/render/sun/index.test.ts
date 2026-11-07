import assert from "node:assert/strict";
import { test } from "node:test";
import { Matrix4, PerspectiveCamera, Vector3 } from "three/webgpu";
import { Cascade } from "../../../src/render/sun/index.ts";

test("far shadows retain coverage between scheduled updates and redraw after a jump", () => {
  const direction = new Vector3(0, 1, 1).normalize();
  const fromSun = new Matrix4().lookAt(new Vector3(), direction.clone().negate(), new Vector3(0, 1, 0));
  const cascade = new Cascade({ size: 2048, every: 2, phase: 0 }, direction, () => 0);
  const camera = new PerspectiveCamera(50, 2, 0.5, 60000);
  camera.position.y = 100;
  const tan = Math.tan((camera.fov * Math.PI) / 360);
  const slope = tan * tan * (1 + camera.aspect * camera.aspect);
  const steps = [
    [0, 0, true],
    [1, 1, false],
    [3, 200, true],
  ] as const;
  for (const [frame, x, redraw] of steps) {
    camera.position.x = x;
    camera.updateMatrixWorld();
    const shadow = cascade.light.shadow;
    const target = cascade.light.target.position.clone();
    shadow.needsUpdate = false;
    cascade.update(camera, 100, 500, slope, frame, fromSun, fromSun.clone().invert());
    assert.equal(shadow.needsUpdate, redraw);
    if (!redraw) assert.deepEqual(cascade.light.target.position, target);
    shadow.updateMatrices(cascade.light);
    for (const distance of [100, 500])
      for (const x of [-1, 1])
        for (const y of [-1, 1]) {
          const corner = new Vector3(x * distance * tan * camera.aspect, y * distance * tan, -distance)
            .applyMatrix4(camera.matrixWorld)
            .applyMatrix4(shadow.camera.matrixWorldInverse);
          assert.ok(Math.abs(corner.x) <= shadow.camera.right && Math.abs(corner.y) <= shadow.camera.top);
          assert.ok(-corner.z >= shadow.camera.near && -corner.z <= shadow.camera.far);
        }
  }
});

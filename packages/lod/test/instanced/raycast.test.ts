import { Matrix4, Raycaster, Sphere, Vector3 } from "three/webgpu";
import { describe, expect, it } from "vitest";
import type { InstancedLodIntersection } from "../../src/instanced/raycast.js";
import { instanceMatrix, oneChunk } from "../instances.js";
import { box } from "../box.js";

const shear = new Matrix4().set(1, 0.9, 0.9, 0, 0.9, 1, 0.9, 0, 0.9, 0.9, 1, 0, 0, 0, 0, 1);

describe("an InstancedLod's raycast", () => {
  it("hits source faces outside the max-axis sphere of a sheared template, naming the chunk and instance", () => {
    const source = box();
    source.matrixAutoUpdate = false;
    source.matrix.copy(shear);
    source.updateMatrixWorld(true);
    // Three's delegated Mesh.raycast also uses max-axis sphere scaling. A consumer
    // can supply a conservative sphere; our outer broadphase must not reject it first.
    source.geometry.boundingSphere = new Sphere(new Vector3(), 4);
    const lod = oneChunk([{ object: source }], 1);
    const other = lod.addChunk({ instanceMatrix: instanceMatrix([new Matrix4().makeTranslation(50, 0, 0), new Matrix4()]) });
    const face = new Vector3(0.8, 0.9, 1).applyMatrix4(shear);
    const ray = new Raycaster(face.clone().add(new Vector3(0, 0, 10)), new Vector3(0, 0, -1));
    const hits: InstancedLodIntersection[] = [];
    lod.raycast(ray, hits);
    expect(hits.map(({ chunk, instanceId }) => [chunk === other, instanceId])).toEqual([
      [false, 0],
      [true, 1],
    ]);
    expect(hits[0]?.object).toBe(lod);
    expect(hits[0]?.point.distanceTo(face)).toBeLessThan(1e-6);
    lod.dispose();
  });
});

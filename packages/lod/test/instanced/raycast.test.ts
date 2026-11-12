import { Matrix4, Raycaster, Sphere, Vector3, type Intersection } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { lodOf } from "../instances.js";
import { box } from "../box.js";

const shear = new Matrix4().set(1, 0.9, 0.9, 0, 0.9, 1, 0.9, 0, 0.9, 0.9, 1, 0, 0, 0, 0, 1);

describe("a Lod's raycast", () => {
  it("hits source faces outside the max-axis sphere of a sheared template, naming the instance, among the first count", () => {
    const source = box();
    source.matrixAutoUpdate = false;
    source.matrix.copy(shear);
    source.updateMatrixWorld(true);
    // Three's delegated Mesh.raycast also uses max-axis sphere scaling. A consumer
    // can supply a conservative sphere; our outer broadphase must not reject it first.
    source.geometry.boundingSphere = new Sphere(new Vector3(), 4);
    const lod = lodOf([{ object: source }], [new Matrix4(), new Matrix4().makeTranslation(50, 0, 0), new Matrix4()]);
    const face = new Vector3(0.8, 0.9, 1).applyMatrix4(shear);
    const ray = new Raycaster(face.clone().add(new Vector3(0, 0, 10)), new Vector3(0, 0, -1));
    const hits: Intersection[] = [];
    lod.raycast(ray, hits);
    expect(hits.map(({ instanceId }) => instanceId)).toEqual([0, 2]);
    expect(hits[0]?.object).toBe(lod);
    expect(hits[0]?.point.distanceTo(face)).toBeLessThan(1e-6);
    lod.count = 2;
    hits.length = 0;
    lod.raycast(ray, hits);
    expect(hits.map(({ instanceId }) => instanceId)).toEqual([0]);
    lod.dispose();
  });
});

import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, SphereGeometry, type Box3 } from "three";
import { describe, expect, it } from "vitest";
import { boundingBox } from "../../src/source/detail.js";
import { lodOf } from "../instances.js";

const spots = [new Matrix4().makeTranslation(-4, 0, 0), new Matrix4().makeTranslation(3, 1, 0), new Matrix4().makeRotationZ(1).setPosition(0, 0, 5)];
const material = new MeshBasicMaterial();

/** Whether `a` and `b` have the same corners, to rounding. */
const same = (a: Box3, b: Box3) => a.min.distanceTo(b.min) < 1e-9 && a.max.distanceTo(b.max) < 1e-9;

describe("boundingBox", () => {
  it("measures every instance of a Lod at its source level, as the same meshes placed by hand", () => {
    const plain = new Group();
    for (const spot of spots) {
      const box = new Mesh(new BoxGeometry(1, 2, 1), material);
      box.applyMatrix4(spot);
      plain.add(box);
    }
    const lod = lodOf([{ object: new Mesh(new BoxGeometry(1, 2, 1), material) }, { object: new Mesh(new SphereGeometry(9), material) }], spots);
    // Before its first update, and moved inside a parent group: placements compose.
    lod.position.set(0, 2, 0);
    plain.position.set(0, 2, 0);
    expect(same(boundingBox(new Group().add(lod)), boundingBox(new Group().add(plain)))).toBe(true);
  });

  it("measures every instance of an InstancedMesh", () => {
    const mesh = new InstancedMesh(new BoxGeometry(1, 2, 1), material, spots.length);
    spots.forEach((spot, i) => mesh.setMatrixAt(i, spot));
    const plain = new Group();
    for (const spot of spots) {
      const box = new Mesh(new BoxGeometry(1, 2, 1), material);
      box.applyMatrix4(spot);
      plain.add(box);
    }
    expect(same(boundingBox(mesh), boundingBox(plain))).toBe(true);
  });
});

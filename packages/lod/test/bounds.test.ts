import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, SphereGeometry } from "three";
import { describe, expect, it } from "vitest";
import { boundingSphere } from "../src/bounds.js";
import { InstancedLod } from "../src/instanced/index.js";

const spots = [new Matrix4().makeTranslation(-4, 0, 0), new Matrix4().makeTranslation(3, 1, 0), new Matrix4().makeRotationZ(1).setPosition(0, 0, 5)];
const material = new MeshBasicMaterial();

describe("boundingSphere", () => {
  it("measures every instance of an InstancedLod at its source level, as the same meshes placed by hand", () => {
    const plain = new Group();
    for (const spot of spots) {
      const box = new Mesh(new BoxGeometry(1, 2, 1), material);
      box.applyMatrix4(spot);
      plain.add(box);
    }
    const lod = new InstancedLod([new Mesh(new BoxGeometry(1, 2, 1), material), new Mesh(new SphereGeometry(9), material)], spots.length);
    spots.forEach((spot, i) => lod.setMatrixAt(i, spot));
    // Before its first update, and moved inside a parent group: placements compose.
    lod.position.set(0, 2, 0);
    plain.position.set(0, 2, 0);
    const measured = boundingSphere(new Group().add(lod));
    const expected = boundingSphere(new Group().add(plain));
    expect(measured.center.distanceTo(expected.center)).toBeLessThan(1e-9);
    expect(measured.radius).toBeCloseTo(expected.radius, 9);
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
    expect(boundingSphere(mesh).radius).toBeCloseTo(boundingSphere(plain).radius, 9);
  });
});

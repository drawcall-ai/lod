import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three/webgpu";
import { simplify } from "@drawcall/lod";
import { propMeshes } from "../../src/world/prop-meshes.ts";

test("batching retains each prop piece's simplification budget", async () => {
  const material = new THREE.MeshStandardMaterial();
  const root = new THREE.Group().add(
    new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), material),
    new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6).translate(2, 0, 0), material),
  );
  const individual = await simplify(root.clone(), { ratio: 0.25 });
  const batched = await simplify(propMeshes(root), { ratio: 0.25 });
  const merged = batched.children[0];
  assert.ok(merged instanceof THREE.Mesh);
  const geometry: THREE.BufferGeometry = merged.geometry;
  assert.deepEqual(
    geometry.groups.map((group) => group.count),
    individual.children.map((mesh) => {
      assert.ok(mesh instanceof THREE.Mesh);
      return mesh.geometry.index?.count;
    }),
  );
  assert.ok(geometry.groups.every((group) => group.count > 0 && group.materialIndex === 0));
});

test("batching preserves nested placement without consuming shared source geometry", () => {
  const material = new THREE.MeshStandardMaterial();
  const geometry = new THREE.BoxGeometry(1, 2, 3);
  let disposed = false;
  geometry.addEventListener("dispose", () => {
    disposed = true;
  });
  const root = new THREE.Group();
  root.position.set(2, 3, -4);
  root.rotation.set(0.2, -0.1, 0.3);
  const branch = new THREE.Group();
  branch.scale.set(2, 1, 0.5);
  root.add(branch);
  for (const x of [-2, 2]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.x = x;
    mesh.rotation.set(0.3, -0.2, 0.1);
    branch.add(mesh);
  }
  const expected = new THREE.Box3().setFromObject(root, true);
  propMeshes(root);
  const actual = new THREE.Box3().setFromObject(root, true);
  assert.ok(actual.min.distanceTo(expected.min) < 1e-5);
  assert.ok(actual.max.distanceTo(expected.max) < 1e-5);
  const merged = root.children.find((child) => child instanceof THREE.Mesh);
  assert.ok(merged instanceof THREE.Mesh);
  assert.equal(merged.material, material);
  assert.equal(merged.geometry.groups.length, 2);
  assert.equal(disposed, false);
});

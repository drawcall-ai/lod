import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three/webgpu";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { variants } from "../../src/content/models.ts";
import { loadManifest } from "../../src/content/materials.ts";

test("lazy variants share original geometry and retain centred authored placement", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ models: { plant: { file: "plant.glb", variants: ["a", "b"] } }, textures: {}, hdri: {} }));
  await loadManifest();
  const scene = new THREE.Group();
  scene.position.set(2, 3, -4);
  scene.scale.set(2, 1, 0.5);
  for (const name of ["a", "b"]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), new THREE.MeshStandardMaterial());
    mesh.name = name;
    mesh.rotation.set(0.3, -0.2, 0.1);
    scene.add(mesh);
  }
  scene.updateMatrixWorld(true);
  const expected: THREE.BufferGeometry[] = scene.children.map((mesh) => {
    assert.ok(mesh instanceof THREE.Mesh);
    const centre = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    return mesh.geometry.clone().applyMatrix4(mesh.matrixWorld).translate(-centre.x, 0, -centre.z);
  });
  t.mock.method(MeshoptDecoder, "useWorkers", () => {});
  const loads = t.mock.method(GLTFLoader.prototype, "loadAsync", async () => ({ scene }));
  const factories = variants("plant");
  assert.equal(loads.mock.callCount(), 0);
  const roots = await Promise.all(factories.map((source) => source()));
  assert.equal(loads.mock.callCount(), 1);
  roots.forEach((root, index) => {
    const selected = root.children[0];
    const original = scene.children[index];
    assert.ok(selected instanceof THREE.Mesh);
    assert.ok(original instanceof THREE.Mesh);
    assert.equal(selected.geometry, original.geometry);
    assert.equal(selected.material, original.material);
    root.updateMatrixWorld(true);
    const placed = selected.geometry.clone().applyMatrix4(selected.matrixWorld);
    for (const name of ["position", "normal"]) {
      const values = expected[index]?.getAttribute(name).array;
      assert.ok(values);
      values.forEach((value, i) => assert.ok(Math.abs(value - placed.getAttribute(name).array[i]) < 1e-5));
    }
    assert.ok(new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3()).setY(0).length() < 1e-5);
  });
});

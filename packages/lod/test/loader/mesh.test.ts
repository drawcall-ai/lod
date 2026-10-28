import {
  BoxGeometry,
  BufferGeometry,
  DataTexture,
  Scene,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
} from "three/webgpu";
import { expect, it } from "vitest";
import { disposeTree } from "../../src/dispose.js";
import { decodeMesh, encodeMesh } from "../../src/loader/mesh.js";

it("preserves a Scene root and placement when decoding a mesh cache subarray", async () => {
  const materials = [new MeshStandardMaterial(), new MeshStandardMaterial()];
  const source = new Scene().add(new Mesh(new BoxGeometry(2, 3, 4), materials[0]), new Mesh(new BoxGeometry(), materials[1]));
  source.position.set(5, 6, 7);
  const encoded = encodeMesh(source, materials);
  const storage = new Uint8Array(encoded.byteLength + 19);
  storage.fill(255);
  const bytes = storage.subarray(7, 7 + encoded.byteLength);
  bytes.set(encoded);
  const restored = await decodeMesh(bytes, materials);
  expect(restored).toBeInstanceOf(Scene);
  expect(restored.position.toArray()).toEqual([5, 6, 7]);
  expect(restored.children).toHaveLength(2);
  const mesh = restored.children[0];
  if (!(mesh instanceof Mesh)) throw new Error("Expected a decoded mesh");
  expect(mesh.geometry.boundingBox?.min.toArray()).toEqual([-1, -1.5, -2]);
  expect(mesh.geometry.boundingBox?.max.toArray()).toEqual([1, 1.5, 2]);
  disposeTree(restored);
  disposeTree(source);
});

it("shares original materials and transparent texture colours while restoring shader attributes", async () => {
  const buffer = new InterleavedBuffer(new Float32Array([1, 2, 3, 7, 4, 5, 6, 8, 7, 8, 9, 9]), 4);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new InterleavedBufferAttribute(buffer, 3, 0));
  geometry.setAttribute("cityShadowPart", new InterleavedBufferAttribute(buffer, 1, 3));
  geometry.setIndex([0, 1, 2]);
  geometry.userData.diameters = [2, 5];
  const material = new MeshStandardNodeMaterial({ name: "atlas" });
  material.map = new DataTexture(new Uint8Array([86, 98, 43, 0]), 1, 1);
  material.userData.surface = { texture: "brick", repeat: [2, 4] };
  const mesh = new Mesh(geometry, material);
  const bytes = encodeMesh(mesh, [material]);
  const restored = await decodeMesh(bytes, [material]);
  if (!(restored instanceof Mesh)) throw new Error("Expected decoded mesh");
  expect(restored.material).toBe(material);
  expect(restored.material.map).toBe(material.map);
  expect(Array.from(restored.material.map.image.data)).toEqual([86, 98, 43, 0]);
  const attribute = restored.geometry.getAttribute("cityShadowPart");
  expect(Array.from({ length: attribute.count }, (_, index) => attribute.getX(index))).toEqual([7, 8, 9]);
  expect(restored.geometry.userData.diameters).toEqual([2, 5]);
  expect(restored.geometry.boundingBox?.min.toArray()).toEqual([1, 2, 3]);
  await expect(decodeMesh(bytes, [])).rejects.toThrow("missing source material");
  geometry.dispose();
  restored.geometry.dispose();
  material.map.dispose();
  material.dispose();
});

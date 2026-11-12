import { DataTexture, Mesh, MeshStandardMaterial, PlaneGeometry } from "three/webgpu";
import { expect, it } from "vitest";
import { Foliage, foliageModel } from "../src/foliage.js";

it("keeps cut-out foliage's alpha threshold and coverage through conversion and cloning", () => {
  const map = new DataTexture(new Uint8Array([90, 120, 40, 255]), 1, 1);
  const source = new MeshStandardMaterial({ map, alphaTest: 0.5 });
  const plant = new Mesh(new PlaneGeometry(), source);
  foliageModel(plant, { translucency: 0.6 });
  expect(plant.material).toBeInstanceOf(Foliage);
  if (!(plant.material instanceof Foliage)) return;
  for (const material of [plant.material, plant.material.clone()]) {
    expect(material.alphaTest).toBe(0.5);
    expect(material.alphaToCoverage).toBe(true);
    expect(material.opacityNode).toBeTruthy();
    expect(material.colorNode).toBeTruthy();
    expect(material.translucency).toBe(0.6);
    material.dispose();
  }
  source.dispose();
  plant.geometry.dispose();
  map.dispose();
});

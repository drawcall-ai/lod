import { Mesh, MeshBasicNodeMaterial, MeshStandardMaterial, OrthographicCamera, PlaneGeometry, Scene } from "three/webgpu";
import { uniform } from "three/tsl";
import { describe, expect, it } from "vitest";
import { levelMaterial, originalOf } from "../src/material.js";
import { GPU_TIMEOUT, render } from "./gpu.js";

describe("levelMaterial", { timeout: GPU_TIMEOUT }, () => {
  it("makes one node copy of a material, swaying or not, for every level that draws it", () => {
    const material = new MeshStandardMaterial({ color: 0x336699, roughness: 0.4 });
    const copy = levelMaterial(material);
    expect(copy.isNodeMaterial).toBe(true);
    expect(copy).toBe(levelMaterial(material));
    expect(levelMaterial(copy)).toBe(copy);
    expect(originalOf(copy)).toBe(material);
    const swaying = levelMaterial(material, true);
    expect(swaying).not.toBe(copy);
    expect(originalOf(swaying)).toBe(material);
    expect(copy.uuid).not.toBe(material.uuid);
    expect(Reflect.get(copy, "roughness")).toBe(0.4);
  });

  it("keeps a node material's own mask and alpha test, and is freed with the original", async () => {
    const material = new MeshBasicNodeMaterial({ alphaTest: 0.5 });
    const mask = uniform(true);
    material.maskNode = mask;
    const copy = levelMaterial(material);
    const geometry = new PlaneGeometry(2, 2);
    const scene = new Scene().add(new Mesh(geometry, copy));
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 2;
    const coverage = async () => (await render(scene, camera)).filter((_, i) => i % 4 === 3).some((alpha) => alpha > 0);
    expect(await coverage()).toBe(true);
    mask.value = false;
    expect(await coverage()).toBe(false);
    // Three's node-material copy omits alphaTest, which controls baked cutouts.
    expect(copy.alphaTest).toBe(0.5);
    let freed = false;
    copy.addEventListener("dispose", () => void (freed = true));
    material.dispose();
    expect(freed).toBe(true);
    geometry.dispose();
  });
});

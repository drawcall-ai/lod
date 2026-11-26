import { Mesh, MeshBasicNodeMaterial, MeshStandardMaterial, OrthographicCamera, PlaneGeometry, Scene } from "three/webgpu";
import { uniform, vec3 } from "three/tsl";
import { describe, expect, it } from "vitest";
import { drawMaterial, originalOf } from "../../src/levels/material.js";
import { GPU_TIMEOUT, render } from "../renderer.js";

describe("drawMaterial", { timeout: GPU_TIMEOUT }, () => {
  it("makes one node copy of a material, swaying or not, for every level that draws it", () => {
    const material = new MeshStandardMaterial({ color: 0x336699, roughness: 0.4 });
    const copy = drawMaterial(material);
    expect(copy.isNodeMaterial).toBe(true);
    expect(copy).toBe(drawMaterial(material));
    expect(drawMaterial(copy)).toBe(copy);
    expect(originalOf(copy)).toBe(material);
    const swaying = drawMaterial(material, "swayingLevel");
    expect(swaying).not.toBe(copy);
    expect(originalOf(swaying)).toBe(material);
    expect(copy.uuid).not.toBe(material.uuid);
    expect(Reflect.get(copy, "roughness")).toBe(0.4);
  });

  it("shares default shader nodes across originals while keeping custom camera and shadow positions", () => {
    const a = new MeshBasicNodeMaterial();
    const b = new MeshBasicNodeMaterial();
    const still = drawMaterial(a);
    const windy = drawMaterial(b, "swayingLevel");
    expect(still.maskNode).toBe(windy.maskNode);
    expect(still.outputNode).toBe(windy.outputNode);
    expect(still.positionNode).toBe(drawMaterial(b).positionNode);
    expect(still.castShadowPositionNode).toBe(drawMaterial(b).castShadowPositionNode);
    expect(windy.positionNode).toBe(drawMaterial(a, "swayingLevel").positionNode);
    expect(still.positionNode).not.toBe(windy.positionNode);
    const standalone = drawMaterial(a, "swayingMesh");
    expect(standalone.positionNode).not.toBe(windy.positionNode);
    expect(standalone.maskNode).toBe(a.maskNode);
    const custom = new MeshBasicNodeMaterial({ castShadowPositionNode: vec3(1) });
    expect(drawMaterial(custom).positionNode).toBe(still.positionNode);
    expect(drawMaterial(custom).castShadowPositionNode).not.toBe(still.castShadowPositionNode);
    const displaced = new MeshBasicNodeMaterial({ positionNode: vec3(2) });
    expect(drawMaterial(displaced).castShadowPositionNode).not.toBe(still.castShadowPositionNode);
    for (const material of [a, b, custom, displaced]) material.dispose();
  });

  it("preserves a node material's own mask and alpha test, and is freed with the original", async () => {
    const material = new MeshBasicNodeMaterial({ alphaTest: 0.5 });
    const mask = uniform(true);
    material.maskNode = mask;
    const copy = drawMaterial(material);
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

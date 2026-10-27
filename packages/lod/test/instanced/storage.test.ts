import { Matrix4, Mesh, MeshBasicNodeMaterial, OrthographicCamera, PlaneGeometry, Scene, StorageBufferAttribute } from "three/webgpu";
import { positionLocal, vec4 } from "three/tsl";
import { expect, it } from "vitest";
import { instanceColors, instanceFades, instanceMatrices, roomBounds } from "../../src/tsl.js";
import { GPU_TIMEOUT, render, renderer } from "../gpu.js";

it("shares programs across storage buffers while keeping each role and object's data separate", { timeout: GPU_TIMEOUT }, async () => {
  const geometry = new PlaneGeometry(0.8, 0.8);
  function mesh(x: number, color: number[], bounds: number[]) {
    const matrices = new StorageBufferAttribute(new Float32Array(new Matrix4().makeTranslation(x, 0, 0).elements), 16);
    const colors = new StorageBufferAttribute(new Float32Array([...color, 0]), 4);
    const boxes = new StorageBufferAttribute(new Float32Array([...bounds, 0]), 4);
    const fades = new StorageBufferAttribute(new Float32Array([0.5]), 1);
    const material = new MeshBasicNodeMaterial();
    material.positionNode = instanceMatrices(matrices).element(0).mul(vec4(positionLocal, 1)).xyz;
    material.colorNode = vec4(instanceColors(colors).element(0).xyz.add(roomBounds(boxes).element(0).xyz).mul(instanceFades(fades).element(0)), 1);
    return {
      object: new Mesh(geometry, material),
      colors,
      dispose() {
        material.dispose();
        for (const attribute of [matrices, colors, boxes, fades]) attribute.dispose();
      },
    };
  }
  const a = mesh(-0.6, [0.5, 0, 0], [0.1, 0, 0]);
  const b = mesh(0.6, [0, 0.5, 0], [0, 0.1, 0]);
  const scene = new Scene().add(a.object);
  const camera = new OrthographicCamera(-1.5, 1.5, 1.5, -1.5, 0.1, 10);
  camera.position.z = 2;
  const pixel = (pixels: Uint8Array, x: number) => Array.from(pixels.slice((32 * 64 + x) * 4, (32 * 64 + x) * 4 + 4));
  try {
    await render(scene, camera);
    const programs = renderer.info.memory.programs;
    scene.add(b.object);
    const pixels = await render(scene, camera);
    expect(renderer.info.memory.programs).toBe(programs);
    const left = pixel(pixels, 16),
      right = pixel(pixels, 48);
    expect(left[0]).toBeGreaterThan(0);
    expect(left.slice(1)).toEqual([0, 0, 255]);
    expect(right[1]).toBeGreaterThan(0);
    expect([right[0], right[2], right[3]]).toEqual([0, 0, 255]);
    a.colors.array.set([0, 0, 0.5, 0]);
    a.colors.needsUpdate = true;
    const changed = await render(scene, camera);
    expect(pixel(changed, 16)[2]).toBeGreaterThan(0);
    expect(pixel(changed, 48)).toEqual(right);
  } finally {
    a.dispose();
    b.dispose();
    geometry.dispose();
  }
});

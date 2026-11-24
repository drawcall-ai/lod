import {
  AmbientLight,
  BoxGeometry,
  DataTexture,
  DirectionalLight,
  Mesh,
  MeshStandardNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
} from "three/webgpu";
import { uniform } from "three/tsl";
import { expect, it } from "vitest";
import { must } from "./must.js";
import { render, renderer } from "./renderer.js";

it("keeps each caster's mask value and map when two materials share a shadow mask", async () => {
  const geometry = new BoxGeometry(0.6, 0.6, 0.1);
  const left = new Mesh(geometry, new MeshStandardNodeMaterial());
  const right = new Mesh(geometry, new MeshStandardNodeMaterial());
  left.position.set(-1, 0, 2);
  right.position.set(1, 0, 2);
  left.castShadow = right.castShadow = true;
  let selected: Mesh | null = left;
  const mask = uniform(0)
    .onObjectUpdate(({ object }) => (selected === null || selected === object ? 1 : 0))
    .greaterThan(0.5);
  left.material.maskShadowNode = right.material.maskShadowNode = mask;

  const wall = new Mesh(new PlaneGeometry(8, 8), new MeshStandardNodeMaterial());
  wall.receiveShadow = true;
  const sun = new DirectionalLight(0xffffff, 3);
  sun.position.set(3, 0, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(256, 256);
  const camera = new OrthographicCamera(-4, 4, 4, -4, 0.1, 20);
  camera.position.z = 8;
  const scene = new Scene().add(left, right, wall, sun, sun.target, new AmbientLight(0xffffff, 0.1));

  const clear = new DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1);
  const solid = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  clear.needsUpdate = solid.needsUpdate = true;
  // The angled light projects both shadows one world unit to the left of their casters.
  async function checkShadow(darkX: number, litX: number) {
    const pixels = await render(scene, camera, 64);
    const red = (x: number) => must(pixels[(32 * 64 + x) * 4]);
    expect(red(litX)).toBeGreaterThan(100);
    expect(red(darkX)).toBeLessThan(red(litX) * 0.5);
  }
  const enabled = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = true;
  try {
    await checkShadow(16, 32);
    selected = right;
    await checkShadow(32, 16);
    selected = null;
    left.material.alphaTest = right.material.alphaTest = 0.5;
    left.material.map = clear;
    right.material.map = solid;
    left.material.needsUpdate = right.material.needsUpdate = true;
    await checkShadow(32, 16);
    left.material.map = solid;
    right.material.map = clear;
    await checkShadow(16, 32);
  } finally {
    renderer.shadowMap.enabled = enabled;
    sun.shadow.dispose();
    for (const resource of [geometry, left.material, right.material, wall.geometry, wall.material, clear, solid]) resource.dispose();
  }
});

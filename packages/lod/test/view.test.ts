import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene } from "three/webgpu";
import { expect, it } from "vitest";
import { setViewportHeight, viewportHeight } from "../src/view.js";
import { GPU_TIMEOUT, render, renderer } from "./gpu.js";
import { Lod } from "../src/lod.js";

it("replaces the initial viewport height independently for each camera", { timeout: GPU_TIMEOUT }, async () => {
  const lod = new Lod([new Mesh(new BoxGeometry(), new MeshBasicMaterial())]);
  const scene = new Scene().add(lod);
  const first = new PerspectiveCamera(),
    second = first.clone();
  first.position.z = second.position.z = 5;
  setViewportHeight(first, 800);
  try {
    await render(scene, first, 64);
    await render(scene, second, 16);
    expect(viewportHeight(first)).toBe(64);
    expect(viewportHeight(second)).toBe(16);
  } finally {
    lod.dispose();
  }
});

it("uses CSS pixels for the canvas and same-sized postprocessing targets", { timeout: GPU_TIMEOUT }, async () => {
  const lod = new Lod([new Mesh(new BoxGeometry(), new MeshBasicMaterial())]);
  const scene = new Scene().add(lod);
  const camera = new PerspectiveCamera();
  camera.position.z = 5;
  renderer.setPixelRatio(2);
  renderer.setSize(64, 64);
  try {
    renderer.render(scene, camera);
    expect(viewportHeight(camera)).toBe(64);
    await render(scene, camera, 128);
    expect(viewportHeight(camera)).toBe(64);
    await render(scene, camera, 96);
    expect(viewportHeight(camera)).toBe(96);
  } finally {
    renderer.setPixelRatio(1);
    lod.dispose();
  }
});

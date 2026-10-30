import {
  AmbientLight,
  BoxGeometry,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  TorusKnotGeometry,
  Vector3,
  type Object3D,
} from "three/webgpu";
import { expect, it } from "vitest";
import { bakeImpostor } from "../../../src/impostor/bake/index.js";
import type { Impostor } from "../../../src/impostor/impostor.js";
import { ImpostorMesh } from "../../../src/impostor/mesh/index.js";
import { readBytes } from "../../../src/renderer.js";
import { GPU_TIMEOUT, render, renderer } from "../../gpu.js";

function atlas(): Impostor {
  return {
    version: 3,
    layout: "full",
    frames: 4,
    size: 16,
    box: [-1, -1, -1, 1, 1, 1],
    halfSize: 1.5,
    maps: ["base", "normalDepth", "orm"],
    layers: [
      [32, 200, 64, 255],
      [128, 128, 255, 128],
      [255, 191, 0, 255],
    ].map((pixel) =>
      [16, 8, 4].map((size) => {
        const data = new Uint8Array(size * size * 4);
        for (let index = 0; index < data.length; index += 4) data.set(pixel, index);
        return data;
      }),
    ),
  };
}

it.each([
  { parallax: 0, samples: 0 },
  { parallax: 0, samples: 4 },
  { parallax: 2, samples: 0 },
  { parallax: 2, samples: 4 },
])("renders coverage with parallax=$parallax and samples=$samples", { timeout: GPU_TIMEOUT }, async ({ parallax, samples }) => {
  const mesh = new ImpostorMesh(atlas(), 1, { parallax });
  const scene = new Scene().add(mesh, new AmbientLight(0xffffff, 3));
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 6;
  const target = new RenderTarget(64, 64, { samples });
  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const pixels = await readBytes(renderer, target, 0);
    const center = (32 * 64 + 32) * 4;
    expect(pixels[center + 1]).toBeGreaterThan(100);
    expect(pixels[center + 1]).toBeGreaterThan((pixels[center] ?? 0) * 2);
    expect(pixels[center + 3]).toBe(255);
    expect(pixels[3]).toBe(0);
  } finally {
    renderer.setRenderTarget(null);
    target.dispose();
    mesh.dispose();
  }
});

it.each([
  ["a knot", new TorusKnotGeometry(1, 0.3, 128, 16), new Vector3(3, 2, 7), 30],
  // From afar, so perspective adds no slack: the card, far narrower than the frame for
  // this box, must still not cut its outline.
  ["a tall thin box from the side", new BoxGeometry(0.3, 3, 0.3).rotateY(0.5), new Vector3(0, 1, 40), 6],
])("looks like the real object: %s", { timeout: GPU_TIMEOUT }, async (_, geometry, eye, fov) => {
  const source = new Mesh(geometry, new MeshStandardMaterial({ color: 0xd06030, roughness: 0.6 }));
  const mesh = new ImpostorMesh(await bakeImpostor(source, { resolution: 128 }));
  const camera = new PerspectiveCamera(fov, 1, 0.1, 100);
  camera.position.copy(eye);
  camera.lookAt(0, 0, 0);
  // No lights: both draw black on white, so compare silhouettes.
  renderer.setClearColor(0xffffff, 1);
  const silhouette = async (object: Object3D) => {
    const pixels = await render(new Scene().add(object), camera, 96);
    return Array.from({ length: pixels.length / 4 }, (_, i) => (pixels[i * 4] ?? 0) < 128);
  };
  const real = await silhouette(source);
  const fake = await silhouette(mesh);
  renderer.setClearColor(0x000000, 0);
  const both = real.filter((a, i) => a && fake[i]).length;
  const either = real.filter((a, i) => a || fake[i]).length;
  expect(both / either).toBeGreaterThan(0.9);
  mesh.dispose();
});

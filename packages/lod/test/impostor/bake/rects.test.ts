import { DataTexture, DoubleSide, Mesh, MeshStandardMaterial, OrthographicCamera, PlaneGeometry, Scene } from "three/webgpu";
import { vec4 } from "three/tsl";
import { expect, it } from "vitest";
import { bakeImpostor } from "../../../src/impostor/bake/index.js";
import { ImpostorMesh } from "../../../src/impostor/mesh/index.js";
import { frameDirection } from "../../../src/impostor/octahedral.js";
import { bakeRenderer, GPU_TIMEOUT, render } from "../../renderer.js";

it("trims empty space around an off-centre cutout while preserving its silhouette between baked views", { timeout: GPU_TIMEOUT }, async () => {
  const data = new Uint8Array(8 * 8 * 4);
  for (let y = 1; y < 5; y++) for (let x = 1; x < 3; x++) data[(y * 8 + x) * 4 + 3] = 255;
  const map = new DataTexture(data, 8, 8);
  map.needsUpdate = true;
  const source = new Mesh(new PlaneGeometry(2, 2), new MeshStandardMaterial({ map, side: DoubleSide, alphaTest: 0.5 }));
  const impostor = await bakeImpostor(source, bakeRenderer, { layout: "hemi", frames: 8, resolution: 64 });
  const stock = { ...impostor };
  delete stock.rects;
  const options = { depth: "card", parallax: 0 } as const;
  const fitted = new ImpostorMesh(impostor, 1, options);
  const full = new ImpostorMesh(stock, 1, options);
  const lowCutoff = new ImpostorMesh(impostor, 1, { ...options, alphaTest: 0.2 });
  const camera = new OrthographicCamera(-1.5, 1.5, 1.5, -1.5, 0.1, 10);
  camera.position.z = 4;
  const alpha = async (mesh: ImpostorMesh, samples = 4, size = 80) =>
    (await render(new Scene().add(mesh), camera, size, samples)).filter((_, i) => i % 4 === 3);
  try {
    // The short axis selects a coarse isotropic mip, widening the cutout across the long axis.
    fitted.scale.y = full.scale.y = 0.05;
    const squashed = await alpha(full, 0);
    expect(squashed.filter(Boolean).length).toBeGreaterThan(8);
    expect(await alpha(fitted, 0)).toEqual(squashed);

    fitted.scale.y = full.scale.y = 1;
    camera.position.set(...frameDirection("hemi", 2, 0.86, 0.93)).multiplyScalar(4);
    camera.lookAt(0, 0, 0);
    const expected = await alpha(full);
    const actual = await alpha(fitted);
    const visible = expected.filter(Boolean).length;
    expect(visible).toBeGreaterThan(200);
    const changed = expected.reduce((sum, a, i) => sum + Math.abs(a - (actual[i] ?? 0)) / 255, 0);
    expect(changed).toBeLessThan(visible * 0.005);

    // Draw the geometry opaque to count every rasterized pixel, including the ones the coverage mask discarded.
    for (const mesh of [fitted, full, lowCutoff]) {
      mesh.material.fragmentNode = vec4(1);
      mesh.material.needsUpdate = true;
    }
    for (const samples of [0, 4]) {
      const fullCard = await alpha(full, samples);
      expect((await alpha(fitted, samples)).filter(Boolean).length).toBeLessThan(fullCard.filter(Boolean).length * 0.75);
      expect(await alpha(lowCutoff, samples)).toEqual(fullCard);
    }
    // Above the reference resolution, fine silhouette details can appear beyond the fitted edges.
    expect(await alpha(fitted, 4, 256)).toEqual(await alpha(full, 4, 256));
  } finally {
    lowCutoff.dispose();
    fitted.dispose();
    full.dispose();
    source.geometry.dispose();
    source.material.dispose();
    map.dispose();
  }
});

it("keeps separated fractional coverage that appears when a small atlas is minified", { timeout: GPU_TIMEOUT }, async () => {
  const data = new Uint8Array(32 * 32 * 4);
  for (let y = 2; y < 30; y++) for (let x = 0; x < 32; x++) data[(y * 32 + x) * 4 + 3] = x < 10 ? 255 : x >= 22 ? 64 : 0;
  const map = new DataTexture(data, 32, 32);
  map.needsUpdate = true;
  const source = new Mesh(new PlaneGeometry(2, 2), new MeshStandardMaterial({ map, side: DoubleSide, transparent: true }));
  const impostor = await bakeImpostor(source, bakeRenderer, { layout: "hemi", frames: 8, resolution: 32 });
  const stock = { ...impostor };
  delete stock.rects;
  const options = { depth: "card", parallax: 0 } as const;
  const fitted = new ImpostorMesh(impostor, 1, options);
  const full = new ImpostorMesh(stock, 1, options);
  const camera = new OrthographicCamera(-5.5, 5.5, 5.5, -5.5, 0.1, 10);
  camera.position.z = 4;
  const faintPixels = async (mesh: ImpostorMesh) => {
    const bytes = await render(new Scene().add(mesh), camera);
    return bytes.filter((_, i) => i % 4 === 3 && Math.floor(i / 4) % 64 >= 34).filter(Boolean).length;
  };
  try {
    const expected = await faintPixels(full);
    expect(expected).toBeGreaterThan(4);
    expect(await faintPixels(fitted)).toBe(expected);
  } finally {
    fitted.dispose();
    full.dispose();
    source.geometry.dispose();
    source.material.dispose();
    map.dispose();
  }
});

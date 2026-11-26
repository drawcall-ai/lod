import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  RGBAFormat,
  Scene,
  TorusKnotGeometry,
  Vector3,
  WebGPURenderer,
  type Node,
  type Object3D,
} from "three/webgpu";
import { dot, normalView, saturate, vec3 } from "three/tsl";
import { expect, it } from "vitest";
import { bakeImpostor } from "../../../src/impostor/bake/index.js";
import type { Impostor } from "../../../src/impostor/impostor.js";
import { ImpostorMesh } from "../../../src/impostor/mesh/index.js";
import { cosine } from "../../../src/impostor/mesh/surface.js";
import { readBytes } from "../../../src/bake.js";
import { GPU_TIMEOUT, bakeRenderer, render, renderer } from "../../renderer.js";
import { lodOf } from "../../instances.js";
import { must } from "../../must.js";

function atlas(normalDepth = [128, 128, 255, 128]): Impostor {
  return {
    version: 4,
    layout: "full",
    frames: 4,
    size: 16,
    box: [-1, -1, -1, 1, 1, 1],
    halfSize: 1.5,
    maps: ["base", "normalDepth", "orm"],
    layers: [[32, 200, 64, 255], normalDepth, [255, 191, 0, 255]].map((pixel) => ({
      format: RGBAFormat,
      mipmaps: [16, 8, 4].map((size) => {
        const data = new Uint8Array(size * size * 4);
        for (let index = 0; index < data.length; index += 4) data.set(pixel, index);
        return data;
      }),
    })),
  };
}

it("samples the selected frames when the requested mip exceeds the atlas chain", { timeout: GPU_TIMEOUT }, async () => {
  const data = atlas();
  const last = must(must(data.layers[0]).mipmaps.at(-1));
  // From +Z the full atlas blends the middle pair on the horizon. Surround them with red.
  for (let i = 0; i < 16; i++) last.set(i === 13 || i === 14 ? [0, 255, 0, 255] : [255, 0, 0, 255], i * 4);
  const mesh = new ImpostorMesh(data, 1, { mipBias: 16, parallax: 0 });
  const scene = new Scene().add(mesh, new AmbientLight(0xffffff, 3));
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 6;
  const target = new RenderTarget(64, 64);
  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const pixels = await readBytes(renderer, target, 0);
    const center = (32 * 64 + 32) * 4;
    expect(pixels[center + 1]).toBeGreaterThan(100);
    expect(pixels[center]).toBeLessThan(10);
  } finally {
    renderer.setRenderTarget(null);
    target.dispose();
    mesh.dispose();
  }
});

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
  const mesh = new ImpostorMesh(await bakeImpostor(source, bakeRenderer, { resolution: 128 }));
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

/** The blue, at the centre, of an impostor all of `normalDepth` under a strong sun at `from`, the camera on +z. */
async function blueLit(normalDepth: number[], from: [number, number, number], term?: (mesh: ImpostorMesh, direction: Node<"vec3">) => Node<"float">) {
  const mesh = new ImpostorMesh(atlas(normalDepth), 1, { parallax: 0 });
  if (term) mesh.material.directTerm = (direction) => vec3(term(mesh, direction));
  const sun = new DirectionalLight(0xffffff, 20);
  sun.position.set(...from);
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 6;
  camera.updateMatrixWorld();
  try {
    const pixels = await render(new Scene().add(mesh, sun), camera);
    return pixels[(32 * 64 + 32) * 4 + 2] ?? 0;
  } finally {
    mesh.dispose();
  }
}

it("gives a lighting term of an app's own how far a texel's normals agree", { timeout: GPU_TIMEOUT }, async () => {
  // Normals agreeing 0.3 toward the camera, the sun straight behind: a share of the leaves is back-lit, not all.
  const shade = (term: (mesh: ImpostorMesh, direction: Node<"vec3">) => Node<"float">) => blueLit([128, 128, 166, 128], [0, 0, -5], term);
  const unit = await shade((_mesh, direction) => saturate(dot(normalView, direction).negate()));
  const spread = await shade((mesh, direction) => cosine(mesh.material.spread, direction.negate()));
  expect(unit).toBeGreaterThan(200);
  expect(spread).toBeGreaterThan(40);
  expect(spread).toBeLessThan(unit * 0.75);
});

it("glares in a low sun ahead only where a texel's normals agree", { timeout: GPU_TIMEOUT }, async () => {
  // Straight up, as a flat surface and as grass, whose normals agree 0.6: blue, scarce in the colour, is the specular.
  const flat = await blueLit([128, 255, 128, 128], [0, 2, -5]);
  const grass = await blueLit([128, 204, 128, 128], [0, 2, -5]);
  expect(flat).toBeGreaterThan(100);
  expect(grass).toBeLessThan(flat / 2);
});

it.each([
  { reversedDepthBuffer: false, orthographic: false },
  { reversedDepthBuffer: true, orthographic: false },
  { reversedDepthBuffer: true, orthographic: true },
])(
  "occludes at the chosen depth (reversed: $reversedDepthBuffer, orthographic: $orthographic)",
  { timeout: GPU_TIMEOUT },
  async ({ reversedDepthBuffer, orthographic }) => {
    const drawing = new WebGPURenderer({ reversedDepthBuffer });
    await drawing.init();
    const target = new RenderTarget(64, 64);
    const source = new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial({ color: 0xe04020 }));
    const impostor = new ImpostorMesh(await bakeImpostor(source, bakeRenderer, { frames: 4, resolution: 32 }));
    const instanced = lodOf([{ object: impostor }], 1);
    const card = new ImpostorMesh(impostor.impostor, 1, { depth: "card" });
    const instancedCard = lodOf([{ object: card }], 1);
    const wall = new Mesh(new PlaneGeometry(4, 4), new MeshStandardMaterial({ color: 0x2040e0 }));
    const camera = orthographic ? new OrthographicCamera(-2, 2, 2, -2, 0.1, 20) : new PerspectiveCamera(40, 1, 0.1, 20);
    camera.position.z = 6;
    // A world-space unit along the ray has a different length in the bake's frame.
    for (const object of [source, impostor, card, instanced, instancedCard]) object.scale.set(1, 0.75, 2);
    const light = new AmbientLight(0xffffff, Math.PI);
    const scene = new Scene();
    const redAtCentre = async (object: Object3D) => {
      scene.clear().add(object, wall, light);
      drawing.setRenderTarget(target);
      drawing.render(scene, camera);
      const pixels = await readBytes(drawing, target, 0);
      drawing.setRenderTarget(null);
      const offset = (32 * 64 + 32) * 4;
      const red = pixels[offset],
        blue = pixels[offset + 2];
      if (red === undefined || blue === undefined) throw new Error("Missing centre pixel");
      return red > blue;
    };
    try {
      // Its first render tells the Lod its renderer, and draws nothing of it.
      drawing.render(new Scene().add(instanced, instancedCard), camera);
      for (const z of [-0.5, 1.5, 2.5]) {
        wall.position.z = z;
        const real = await redAtCentre(source);
        const proxy = await redAtCentre(impostor);
        expect(real).toBe(z < 2);
        expect(proxy).toBe(z < 2);
        expect(await redAtCentre(instanced)).toBe(z < 2);
        expect(await redAtCentre(card)).toBe(z < 0);
        expect(await redAtCentre(instancedCard)).toBe(z < 0);
      }
      // Writing the rasterized depth explicitly gives the same image but costs early rejection on overlapping cards.
      const { fragmentShader } = await drawing.debug.getShaderAsync(new Scene().add(card), camera, card);
      expect(fragmentShader).toBeTypeOf("string");
      expect(fragmentShader).not.toContain("frag_depth");
    } finally {
      instancedCard.dispose();
      card.dispose();
      instanced.dispose();
      impostor.dispose();
      source.geometry.dispose();
      source.material.dispose();
      wall.geometry.dispose();
      wall.material.dispose();
      target.dispose();
      drawing.dispose();
    }
  },
);

it("casts at reconstructed depth when the camera draws card depth", { timeout: GPU_TIMEOUT }, async () => {
  const source = new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial());
  const card = new ImpostorMesh(await bakeImpostor(source, bakeRenderer, { frames: 4, resolution: 32 }), 1, { depth: "card" });
  card.castShadow = true;
  card.layers.set(1);
  const wall = new Mesh(new PlaneGeometry(4, 4), new MeshStandardMaterial());
  wall.receiveShadow = true;
  const sun = new DirectionalLight(0xffffff, 3);
  sun.position.set(0, 0, 6);
  sun.castShadow = true;
  sun.shadow.camera.layers.enable(1);
  const camera = new PerspectiveCamera(40, 1, 0.1, 20);
  camera.position.z = 6;
  const scene = new Scene().add(card, wall, sun, sun.target);
  const shadows = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = true;
  try {
    // The receiver at 0.5 is in front of the card plane but behind the box face at 1.
    const brightness = async (z: number) => {
      wall.position.z = z;
      const pixels = await render(scene, camera, 64);
      return must(pixels[(32 * 64 + 32) * 4]);
    };
    const lit = await brightness(1.5);
    expect(lit).toBeGreaterThan(100);
    expect(await brightness(0.5)).toBeLessThan(lit * 0.5);
  } finally {
    renderer.shadowMap.enabled = shadows;
    sun.shadow.dispose();
    card.dispose();
    wall.geometry.dispose();
    wall.material.dispose();
    source.geometry.dispose();
    source.material.dispose();
  }
});

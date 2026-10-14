// Bakes and renders on a real WebGL2 context in Node (webgl-node): the GPU, or Mesa's
// llvmpipe on machines without one.
import {
  AdditiveBlending,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  SRGBColorSpace,
  SphereGeometry,
  TorusKnotGeometry,
  WebGLRenderTarget,
  WebGLRenderer,
  type Object3D,
} from "three";
import { createWebGL2Context } from "webgl-node";
import { describe, expect, it } from "vitest";
import { bakeImpostor } from "../src/bake/index.js";
import type { Impostor } from "../src/impostor.js";
import { ImpostorMesh } from "../src/mesh/index.js";

const { canvas, gl } = createWebGL2Context(1, 1);
const renderer = new WebGLRenderer({ canvas, context: gl });
const bake = (object: Object3D, layout: Impostor["layout"] = "full") => bakeImpostor(object, { renderer, layout, resolution: 32 });

/** Share of atlas texels with any coverage. */
const coverage = (impostor: Impostor) => {
  const [base] = impostor.layers;
  if (!base) throw new Error("no base layer");
  let covered = 0;
  for (let i = 3; i < base.length; i += 4) if (base[i] !== 0) covered++;
  return covered / (base.length / 4);
};

describe("bakeImpostor", () => {
  it("bakes colour, normal+depth and ORM, and emissive only when something visible emits", async () => {
    const knot = new Mesh(new TorusKnotGeometry(1, 0.3, 64, 8), new MeshStandardMaterial({ color: 0xd06030 }));
    const plain = await bake(knot);
    expect(plain.maps).toEqual(["base", "normalDepth", "orm"]);
    expect(coverage(plain)).toBeGreaterThan(0.2);

    const glowing = new Group().add(knot.clone(), new Mesh(new SphereGeometry(0.2), new MeshStandardMaterial({ emissive: 0xffaa00 })));
    expect((await bake(glowing)).maps).toEqual(["base", "normalDepth", "orm", "emissive"]);

    const hidden = new Mesh(new SphereGeometry(0.2), new MeshStandardMaterial({ emissive: 0xffaa00 }));
    hidden.visible = false;
    expect((await bake(new Group().add(knot.clone(), hidden))).maps).toEqual(["base", "normalDepth", "orm"]);
  });

  it("ignores the material's blending: additive bakes the same atlas", async () => {
    const make = (blending?: typeof AdditiveBlending) => new Mesh(new SphereGeometry(1, 16, 8), new MeshStandardMaterial({ color: 0x3080c0, ...(blending ? { blending } : {}) }));
    const [normal, additive] = await Promise.all([bake(make()), bake(make(AdditiveBlending))]);
    normal.layers.forEach((layer, i) => expect(Buffer.compare(layer, additive.layers[i] ?? new Uint8Array())).toBe(0));
  });

  it("keeps the cut-out of alpha-to-coverage materials", async () => {
    // Left half opaque, right half transparent.
    const map = new DataTexture(new Uint8Array([255, 255, 255, 255, 255, 255, 255, 0]), 2, 1, RGBAFormat);
    map.magFilter = map.minFilter = NearestFilter;
    map.colorSpace = SRGBColorSpace;
    map.needsUpdate = true;
    const card = (cut: boolean) => new Mesh(new PlaneGeometry(2, 2), new MeshStandardMaterial({ map, side: DoubleSide, alphaToCoverage: cut }));
    const [solid, cut] = await Promise.all([bake(card(false), "hemi"), bake(card(true), "hemi")]);
    expect(coverage(cut) / coverage(solid)).toBeGreaterThan(0.35);
    expect(coverage(cut) / coverage(solid)).toBeLessThan(0.65);
  });

  it("rejects bad options and objects without extent", async () => {
    const knot = new Mesh(new TorusKnotGeometry(), new MeshStandardMaterial());
    await expect(bakeImpostor(knot, { renderer, frames: 1 })).rejects.toThrow(/frames/);
    await expect(bakeImpostor(knot, { renderer, resolution: 0 })).rejects.toThrow(/resolution/);
    await expect(bakeImpostor(knot, { renderer, supersample: 1.5 })).rejects.toThrow(/supersample/);
    const point = new BufferGeometry().setAttribute("position", new Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
    await expect(bakeImpostor(new Mesh(point, new MeshStandardMaterial()), { renderer })).rejects.toThrow(/no extent/);
  });
});

describe("ImpostorMesh rendering", () => {
  it("looks like the real object", async () => {
    const knot = new Mesh(new TorusKnotGeometry(1, 0.3, 128, 16), new MeshStandardMaterial({ color: 0xd06030, roughness: 0.6 }));
    const impostor = await bakeImpostor(knot, { renderer, resolution: 128 });
    const mesh = new ImpostorMesh(impostor);
    const camera = new PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(3, 2, 7);
    camera.lookAt(0, 0, 0);
    const render = (object: Object3D) => {
      const scene = new Scene().add(object);
      const target = new WebGLRenderTarget(96, 96, { samples: 4 });
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const pixels = new Uint8Array(96 * 96 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 96, 96, pixels);
      renderer.setRenderTarget(null);
      target.dispose();
      return pixels;
    };
    const real = render(knot);
    const fake = render(mesh);
    let both = 0;
    let either = 0;
    for (let i = 3; i < real.length; i += 4) {
      const a = (real[i] ?? 0) > 128;
      const b = (fake[i] ?? 0) > 128;
      if (a && b) both++;
      if (a || b) either++;
    }
    // No lights, so both render black: compare silhouettes.
    expect(both / either).toBeGreaterThan(0.85);
    mesh.dispose();
  });
});

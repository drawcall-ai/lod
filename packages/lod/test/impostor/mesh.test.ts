import {
  BoxGeometry,
  Matrix4,
  Mesh,
  ShaderChunk,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  TorusKnotGeometry,
  Vector3,
  WebGLRenderTarget,
  type Object3D,
  type Texture,
} from "three";
import { describe, expect, it } from "vitest";
import { fadeUniformsOf } from "../../src/fade.js";
import { bakeImpostor } from "../../src/impostor/bake/index.js";
import type { Impostor } from "../../src/impostor/impostor.js";
import { ImpostorMesh } from "../../src/impostor/mesh/index.js";
import { isTexture } from "../../src/three.js";
import { GPU_TIMEOUT, compile, renderer } from "../webgl.js";

const make = (): Impostor => ({
  version: 2,
  layout: "full",
  frames: 4,
  size: 16,
  box: [-1, 0, -1, 1, 2, 1],
  halfSize: 1.5,
  maps: ["base", "normalDepth", "orm"],
  layers: [0, 1, 2].map(() => [16, 8, 4].map((size) => new Uint8Array(size * size * 4))),
});

const baseTexture = (mesh: ImpostorMesh): Texture => {
  const value: unknown = compile(mesh.material).uniforms.impostorBase?.value;
  if (!isTexture(value)) throw new Error("no base texture uniform");
  return value;
};

describe("ImpostorMesh", { timeout: GPU_TIMEOUT }, () => {
  it("patches three's standard shader in every pass", () => {
    const mesh = new ImpostorMesh(make());
    const lit = compile(mesh.material);
    expect(lit.vertexShader).toContain("impostorEncode(impostorView)");
    expect(lit.fragmentShader).toContain("impostorShadowS");
    expect(lit.fragmentShader).not.toContain("#include <map_fragment>");
  });

  it("lights with three's chunks as they are when it compiles, at the resolved surface", () => {
    const original = ShaderChunk.lights_fragment_begin;
    ShaderChunk.lights_fragment_begin = `${original}\n// patched after the package loaded`;
    try {
      // Options no other test uses, so three compiles a program of its own.
      const lit = compile(new ImpostorMesh(make(), 1, { tolerance: 0.0123 }).material);
      expect(lit.fragmentShader).toContain("// patched after the package loaded");
      expect(lit.fragmentShader).toContain("vec3 geometryPosition = vImpostorViewPoint");
    } finally {
      ShaderChunk.lights_fragment_begin = original;
    }
  });

  it.each([
    ["alphaTest", { alphaTest: 0 }],
    ["alphaTest", { alphaTest: 1 }],
    ["parallax", { parallax: 1.5 }],
    ["tolerance", { tolerance: 0 }],
    ["mipBias", { mipBias: NaN }],
  ])("rejects a bad %s", (_, options) => {
    expect(() => new ImpostorMesh(make(), 1, options)).toThrow();
  });

  it("keeps tiny option values exact in the shader", () => {
    const { defines } = new ImpostorMesh(make(), 1, { tolerance: 0.00001 }).material;
    expect(Number(defines?.IMPOSTOR_TOLERANCE)).toBe(0.00001);
  });

  it("shares textures between meshes of one impostor until the last is disposed", () => {
    const impostor = make();
    const a = new ImpostorMesh(impostor);
    const b = new ImpostorMesh(impostor);
    const texture = baseTexture(a);
    expect(baseTexture(b)).toBe(texture);
    let disposed = 0;
    texture.addEventListener("dispose", () => disposed++);
    a.dispose();
    a.dispose();
    expect(disposed).toBe(0);
    b.dispose();
    expect(disposed).toBe(1);
  });

  it("clones with its own material and fade uniforms", () => {
    const mesh = new ImpostorMesh(make(), 2);
    const clone = mesh.clone();
    expect(clone).toBeInstanceOf(ImpostorMesh);
    expect(clone.material).not.toBe(mesh.material);
    expect(fadeUniformsOf(clone.material)).not.toBe(fadeUniformsOf(mesh.material));
    expect(fadeUniformsOf(clone.customDepthMaterial ?? clone.material)).toBe(fadeUniformsOf(clone.material));
    expect(() => new ImpostorMesh(make()).copy(mesh)).toThrow(/different impostor/);
  });

  it("raycasts against each instance's box", () => {
    const mesh = new ImpostorMesh(make(), 2);
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(10, 0, 0));
    mesh.updateMatrixWorld();
    const hits: Parameters<ImpostorMesh["raycast"]>[1] = [];
    mesh.raycast(new Raycaster(new Vector3(10, 1, 10), new Vector3(0, 0, -1)), hits);
    expect(hits.map((h) => [h.instanceId, h.distance])).toEqual([[1, 9]]);
  });

  it.each([
    ["a knot", new TorusKnotGeometry(1, 0.3, 128, 16), new Vector3(3, 2, 7), 30],
    // From afar, so perspective adds no slack: the card, far narrower than the frame for
    // this box, must still not cut its outline.
    ["a tall thin box from the side", new BoxGeometry(0.3, 3, 0.3).rotateY(0.5), new Vector3(0, 1, 40), 6],
  ])("looks like the real object: %s", async (_, geometry, eye, fov) => {
    const knot = new Mesh(geometry, new MeshStandardMaterial({ color: 0xd06030, roughness: 0.6 }));
    const mesh = new ImpostorMesh(await bakeImpostor(knot, { renderer, resolution: 128 }));
    const camera = new PerspectiveCamera(fov, 1, 0.1, 100);
    camera.position.copy(eye);
    camera.lookAt(0, 0, 0);
    const render = (object: Object3D) => {
      const target = new WebGLRenderTarget(96, 96, { samples: 4 });
      renderer.setRenderTarget(target);
      renderer.render(new Scene().add(object), camera);
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
    expect(both / either).toBeGreaterThan(0.9);
    mesh.dispose();
  });
});

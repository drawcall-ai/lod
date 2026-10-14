import { Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, Raycaster, ShaderLib, Vector2, Vector3, type Texture, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from "three";
import { describe, expect, it } from "vitest";
import { fadeMaterial, fadeObject } from "../src/handoff.js";
import type { Impostor } from "../src/impostor.js";
import { ImpostorMesh } from "../src/mesh/index.js";

const make = (): Impostor => ({
  version: 1,
  layout: "full",
  frames: 4,
  size: 16,
  box: [-1, 0, -1, 1, 2, 1],
  halfSize: 1.5,
  maps: ["base", "normalDepth", "orm"],
  layers: [0, 1, 2].map(() => new Uint8Array(16 * 16 * 4)),
});

/** Runs a material's shader patch on three's own standard shader, as the renderer would. */
function compile(material: { onBeforeCompile: MeshStandardMaterial["onBeforeCompile"] }): WebGLProgramParametersWithUniforms {
  const shader = { uniforms: {}, vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader } as WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as WebGLRenderer);
  return shader;
}

const baseTexture = (mesh: ImpostorMesh): Texture => {
  const uniform = compile(mesh.material).uniforms.impostorBase;
  if (!uniform?.value) throw new Error("no base texture uniform");
  return uniform.value as Texture;
};

describe("ImpostorMesh", () => {
  it("patches three's standard shader in every pass", () => {
    const mesh = new ImpostorMesh(make());
    const lit = compile(mesh.material);
    expect(lit.vertexShader).toContain("impostorEncode(impostorView)");
    expect(lit.fragmentShader).toContain("impostorShadowS");
    expect(lit.fragmentShader).not.toContain("#include <map_fragment>");
  });

  it.each([
    ["alphaTest", { alphaTest: 0 }],
    ["alphaTest", { alphaTest: 1 }],
    ["parallax", { parallax: 1.5 }],
    ["tolerance", { tolerance: 0 }],
    ["fade band", { fadeBand: [0.09, 0.06] as [number, number] }],
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

  it("clones with its own material and a copy of the band", () => {
    const mesh = new ImpostorMesh(make(), 2, { fadeBand: [0.06, 0.09] });
    const clone = mesh.clone();
    expect(clone.material).not.toBe(mesh.material);
    expect(clone.fadeBand).not.toBe(mesh.fadeBand);
    expect(clone.fadeBand.toArray()).toEqual([0.06, 0.09]);
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
});

describe("hand-off", () => {
  it("fades every mesh under a root and shares the band", () => {
    const root = new Mesh(new PlaneGeometry(), new MeshStandardMaterial());
    root.add(new Mesh(new PlaneGeometry(), new MeshStandardMaterial()));
    const band = new Vector2(0.06, 0.09);
    expect(fadeObject(root, make(), band)).toBe(band);
    root.traverse((node) => {
      const material = (node as Mesh).material as MeshStandardMaterial;
      expect(compile(material).fragmentShader).toContain("impostorDither(gl_FragCoord.xy) > smoothstep");
    });
  });

  it("chains an existing patch, refuses a second one and a bad band", () => {
    const material = new MeshStandardMaterial();
    let chained = false;
    material.onBeforeCompile = () => void (chained = true);
    fadeMaterial(material, make(), [0.06, 0.09]);
    compile(material);
    expect(chained).toBe(true);
    expect(() => fadeMaterial(material, make(), [0.06, 0.09])).toThrow(/already faded/);
    expect(() => fadeMaterial(new MeshStandardMaterial(), make(), [0.09, 0.06])).toThrow(/fade band/);
  });
});

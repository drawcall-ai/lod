import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Raycaster,
  Scene,
  TorusKnotGeometry,
  Vector3,
  type Object3D,
} from "three/webgpu";
import { describe, expect, it } from "vitest";
import { bakeImpostor } from "../../src/impostor/bake/index.js";
import type { Impostor } from "../../src/impostor/impostor.js";
import { ImpostorMesh } from "../../src/impostor/mesh/index.js";
import { acquireTextures, releaseTextures } from "../../src/impostor/mesh/textures.js";
import { GPU_TIMEOUT, render, renderer } from "../gpu.js";

const make = (): Impostor => ({
  version: 3,
  layout: "full",
  frames: 4,
  size: 16,
  box: [-1, 0, -1, 1, 2, 1],
  halfSize: 1.5,
  maps: ["base", "normalDepth", "orm"],
  layers: [0, 1, 2].map(() => [16, 8, 4].map((size) => new Uint8Array(size * size * 4))),
});

/** The textures `impostor`'s meshes share, without holding them. */
function texturesOf(impostor: Impostor) {
  const textures = acquireTextures(impostor);
  releaseTextures(impostor);
  return textures;
}

describe("ImpostorMesh", { timeout: GPU_TIMEOUT }, () => {
  it.each([
    ["alphaTest", { alphaTest: 0 }],
    ["alphaTest", { alphaTest: 1 }],
    ["parallax", { parallax: 1.5 }],
    ["tolerance", { tolerance: 0 }],
    ["mipBias", { mipBias: NaN }],
  ])("rejects a bad %s", (_, options) => {
    expect(() => new ImpostorMesh(make(), 1, options)).toThrow();
  });

  it("shares textures between meshes of one impostor until the last is disposed", () => {
    const impostor = make();
    const a = new ImpostorMesh(impostor);
    const clone = a.clone();
    const b = new ImpostorMesh(impostor);
    const [texture] = texturesOf(impostor);
    let disposed = 0;
    texture?.addEventListener("dispose", () => disposed++);
    a.dispose();
    a.dispose();
    clone.dispose();
    expect(disposed).toBe(0);
    b.dispose();
    expect(disposed).toBe(1);
  });

  it("clones sharing its material, so that clones draw with one shader", () => {
    const mesh = new ImpostorMesh(make(), 2);
    mesh.setColorAt(1, new Color(1, 0, 0));
    const clone = mesh.clone();
    expect(clone).toBeInstanceOf(ImpostorMesh);
    expect(clone.material).toBe(mesh.material);
    expect(clone.getColorAt(1, new Color()).getHex()).toBe(0xff0000);
    expect(clone.instanceColor).not.toBe(mesh.instanceColor);
    expect(() => new ImpostorMesh(make()).copy(mesh)).toThrow(/different impostor/);
  });

  it("replaces a reused copy's instances and releases its old material when its last clone is gone", () => {
    const impostor = make();
    const source = new ImpostorMesh(impostor, 2, { mipBias: 1 });
    source.setMatrixAt(1, new Matrix4().makeTranslation(10, 0, 0));
    const target = new ImpostorMesh(impostor);
    target.setColorAt(0, new Color(1, 0, 0));
    const oldClone = target.clone();
    const matrix = target.instanceMatrix;
    let oldMaterialFreed = 0;
    let oldColorFreed = 0;
    target.material.addEventListener("dispose", () => oldMaterialFreed++);
    target.instanceColor?.addEventListener("dispose", () => oldColorFreed++);
    const [texture] = texturesOf(impostor);
    let texturesFreed = 0;
    texture?.addEventListener("dispose", () => texturesFreed++);
    target.copy(source);
    expect(target.count).toBe(2);
    expect(target.getMatrixAt(1, new Matrix4()).elements[12]).toBe(10);
    expect(target.instanceMatrix !== matrix || target.instanceMatrix.version > matrix.version).toBe(true);
    expect(target.getColorAt(0, new Color()).getHex()).toBe(0xffffff);
    expect(target.options).toEqual(source.options);
    expect(oldColorFreed).toBe(1);
    expect(oldMaterialFreed).toBe(0);
    oldClone.dispose();
    expect(oldMaterialFreed).toBe(1);
    source.dispose();
    expect(texturesFreed).toBe(0);
    target.dispose();
    expect(texturesFreed).toBe(1);
  });

  it("draws instance colours, white where none is set, in direct light too", async () => {
    const impostor = await bakeImpostor(new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial()), { frames: 4, resolution: 16 });
    // Clones of one instance share a shader, whichever builds it: one without colours, one with.
    const white = new ImpostorMesh(impostor);
    const red = white.clone();
    red.setColorAt(0, new Color(1, 0, 0));
    white.position.set(-2, -2, 0);
    red.position.set(2, -2, 0);
    // Two instances build a shader of their own, with colours.
    const pair = new ImpostorMesh(impostor, 2);
    pair.setMatrixAt(0, new Matrix4().makeTranslation(-2, 2, 0));
    pair.setMatrixAt(1, new Matrix4().makeTranslation(2, 2, 0));
    pair.setColorAt(0, new Color(1, 1, 1));
    pair.setColorAt(1, new Color(1, 0, 0));
    pair.computeBoundingSphere();
    const camera = new OrthographicCamera(-4, 4, 4, -4, 0.1, 20);
    camera.position.set(0, 0, 10);
    const pixels = await render(new Scene().add(white, red, pair, new AmbientLight(0xffffff, 1), new DirectionalLight(0xffffff, 3)), camera);
    // Rows bottom-up: a quarter in from either side, a quarter from the bottom or top.
    const at = (x: number, y: number) => Array.from(pixels.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 3));
    for (const y of [16, 48]) {
      const [left, right] = [at(16, y), at(48, y)];
      expect(left[1]).toBeGreaterThan(60);
      expect(right[0]).toBeGreaterThan(60);
      expect(right[1]).toBeLessThan(10);
    }
    pair.dispose();
    white.dispose();
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
});

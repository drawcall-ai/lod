import { Color, Matrix4, Raycaster, Vector3 } from "three/webgpu";
import { describe, expect, it } from "vitest";
import type { Impostor } from "../../../src/impostor/impostor.js";
import { ImpostorMesh } from "../../../src/impostor/mesh/index.js";
import { acquireTextures, releaseTextures } from "../../../src/impostor/mesh/textures.js";
import { GPU_TIMEOUT } from "../../gpu.js";

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

  it("clones sharing its material without invalidating already-drawing siblings", () => {
    const mesh = new ImpostorMesh(make(), 2);
    const plainVersion = mesh.material.version;
    const plain = mesh.clone();
    expect(mesh.material.version).toBe(plainVersion);
    mesh.setColorAt(1, new Color(1, 0, 0));
    const coloredVersion = mesh.material.version;
    const clone = mesh.clone();
    expect(mesh.material.version).toBe(coloredVersion);
    expect(clone).toBeInstanceOf(ImpostorMesh);
    expect(clone.material).toBe(mesh.material);
    expect(clone.getColorAt(1, new Color()).getHex()).toBe(0xff0000);
    expect(clone.instanceColor).not.toBe(mesh.instanceColor);
    expect(() => new ImpostorMesh(make()).copy(mesh)).toThrow(/different impostor/);
    plain.dispose();
    clone.dispose();
    mesh.dispose();
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

  it("raycasts against each instance's box", () => {
    const mesh = new ImpostorMesh(make(), 2);
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(10, 0, 0));
    mesh.updateMatrixWorld();
    const hits: Parameters<ImpostorMesh["raycast"]>[1] = [];
    mesh.raycast(new Raycaster(new Vector3(10, 1, 10), new Vector3(0, 0, -1)), hits);
    expect(hits.map((h) => [h.instanceId, h.distance])).toEqual([[1, 9]]);
  });
});

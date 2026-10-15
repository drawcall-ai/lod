import {
  BoxGeometry,
  CompressedTexture,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  type BufferGeometry,
  type Object3D,
} from "three";
import { describe, expect, it } from "vitest";
import { boundingSphere } from "../src/bounds.js";
import type { Impostor } from "../src/impostor/impostor.js";
import { ImpostorMesh } from "../src/impostor/mesh/index.js";
import { InstancedLod } from "../src/instanced/index.js";
import { Lod } from "../src/lod.js";
import { simplify } from "../src/simplify.js";
import { isImpostorMesh, isInstancedMesh, isLOD, isMesh } from "../src/three.js";
import { must } from "./must.js";

const triangles = (geometry: BufferGeometry) => (geometry.index?.count ?? 0) / 3;
const meshes = (root: Object3D) => root.children.filter(isMesh);
const sphere = (material = new MeshStandardMaterial()) => new Mesh(new SphereGeometry(1, 64, 32), material);

/** How far `copy` is from `source`, in `source`'s units, read back from the default maxPixels it gets in a Lod. */
const error = (source: Object3D, copy: Object3D) => (2 * boundingSphere(source).radius) / must(new Lod([source.clone(), copy]).levels[1]).maxPixels;

describe("simplify", () => {
  it("reduces triangles, keeps materials and shared geometry shared, and measures its error in the source's units", async () => {
    const geometry = new SphereGeometry(1, 64, 32);
    const material = new MeshStandardMaterial();
    const scaled = new Mesh(geometry, material);
    scaled.scale.setScalar(3);
    const source = new Group().add(new Mesh(geometry, material), scaled);
    const copy = await simplify(source, { ratio: 0.1 });
    const [a, b] = meshes(copy).map((mesh) => mesh.geometry);
    expect(a).toBe(b);
    expect(triangles(must(a))).toBeLessThan(triangles(geometry) * 0.15);
    expect(triangles(must(a))).toBeGreaterThan(0);
    expect(meshes(copy).every((mesh) => mesh.material === material)).toBe(true);
    // The scaled copy, most of the area, moved three times as far.
    const single = new Mesh(geometry, material);
    expect(error(source, copy) / (3 * error(single, await simplify(single, { ratio: 0.1 })))).toBeCloseTo(1, 1);
    await expect(simplify(source, { ratio: 0 })).rejects.toThrow(/ratio/);
  });

  it("simplifies a nested Lod's source whatever it shows, and leaves its other levels", async () => {
    const material = new MeshStandardMaterial();
    const far = new Mesh(new SphereGeometry(1, 8, 4), material);
    const inner = new Lod([sphere(material), far]);
    inner.levels.forEach((level, i) => (level.object.visible = i === 1));
    const [nested] = (await simplify(new Group().add(inner), { ratio: 0.1 })).children;
    if (!nested || !isLOD(nested)) throw new Error("expected the nested Lod");
    const [source, cheap] = nested.levels.map((level) => (isMesh(level.object) ? triangles(level.object.geometry) : 0));
    expect(source).toBeLessThan(64 * 32 * 2 * 0.15);
    expect(cheap).toBe(triangles(far.geometry));
  });

  it("simplifies an InstancedMesh's geometry, keeps ImpostorMeshes and refuses an InstancedLod", async () => {
    const impostor: Impostor = {
      version: 2,
      layout: "full",
      frames: 4,
      size: 16,
      box: [-1, 0, -1, 1, 2, 1],
      halfSize: 1.5,
      maps: ["base", "normalDepth", "orm"],
      layers: [0, 1, 2].map(() => [16, 8, 4].map((size) => new Uint8Array(size * size * 4))),
    };
    const instanced = new InstancedMesh(new SphereGeometry(1, 64, 32), new MeshStandardMaterial(), 2);
    instanced.setMatrixAt(1, new Matrix4().makeTranslation(3, 0, 0));
    const card = new ImpostorMesh(impostor);
    card.position.x = -3;
    const copy = await simplify(new Group().add(instanced, card), { ratio: 0.1 });
    const [many, kept] = copy.children;
    if (!many || !isInstancedMesh(many) || !kept || !isImpostorMesh(kept)) throw new Error("expected the instanced mesh and the impostor");
    expect(triangles(many.geometry)).toBeLessThan(triangles(instanced.geometry) * 0.15);
    expect(many.count).toBe(2);
    expect(kept.impostor).toBe(impostor);
    await expect(simplify(new Group().add(new InstancedLod([sphere()], 2)), { ratio: 0.5 })).rejects.toThrow(/InstancedLod/);
  });

  it("measures a source whose cut-out textures the CPU cannot read, as opaque", async () => {
    const leaves = new MeshStandardMaterial({ map: new CompressedTexture([], 4, 4), alphaTest: 0.5 });
    const copy = await simplify(new Mesh(new BoxGeometry(1, 1, 1, 8, 8, 8), leaves), { ratio: 0.5 });
    expect(isMesh(copy)).toBe(true);
  });
});

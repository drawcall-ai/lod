import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CompressedTexture,
  DataTexture,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  RGBAFormat,
  SphereGeometry,
  Vector3,
  type Object3D,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { boundingBox } from "../../src/source/detail.js";
import type { Impostor } from "../../src/impostor/impostor.js";
import { ImpostorMesh } from "../../src/impostor/mesh/index.js";
import { InstancedLod } from "../../src/instanced/index.js";
import { Lod } from "../../src/lod.js";
import { simplify } from "../../src/simplify/index.js";
import { isImpostorMesh, isInstancedMesh, isLOD, isMesh } from "../../src/three.js";
import { area } from "../../src/source/surface.js";
import { must } from "../must.js";
import { gpu } from "../renderer.js";

const triangles = (geometry: BufferGeometry) => (geometry.index?.count ?? 0) / 3;
const meshes = (root: Object3D) => root.children.filter(isMesh);
const sphere = (material = new MeshStandardMaterial()) => new Mesh(new SphereGeometry(1, 64, 32), material);

/** How far `copy` is from `source`, in `source`'s units, read back from the default maxPixels it gets in a Lod. */
const deviation = (source: Object3D, copy: Object3D) =>
  boundingBox(source).getSize(new Vector3()).length() / must(new Lod([{ object: source.clone() }, { object: copy }], gpu).levels[1]).maxPixels;

describe("simplify", () => {
  it("reduces triangles, shares the materials and geometry the source shares, and measures its deviation in the source's units", async () => {
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
    expect(deviation(source, copy) / (3 * deviation(single, await simplify(single, { ratio: 0.1 })))).toBeCloseTo(1, 1);
    await expect(simplify(source, { ratio: 0 })).rejects.toThrow(/ratio/);
  });

  it("simplifies a nested Lod's source whatever it shows, and leaves its other levels", async () => {
    const material = new MeshStandardMaterial();
    const far = new Mesh(new SphereGeometry(1, 8, 4), material);
    const inner = new Lod([{ object: sphere(material) }, { object: far }], gpu);
    inner.levels.forEach((level, i) => (must(level.object).visible = i === 1));
    const [nested] = (await simplify(new Group().add(inner), { ratio: 0.1 })).children;
    if (!nested || !isLOD(nested)) throw new Error("expected the nested Lod");
    const [source, cheap] = nested.levels.map((level) => (level.object && isMesh(level.object) ? triangles(level.object.geometry) : 0));
    expect(source).toBeLessThan(64 * 32 * 2 * 0.15);
    expect(cheap).toBe(triangles(far.geometry));
  });

  it("simplifies an InstancedMesh's geometry, leaves ImpostorMeshes as they are and refuses an InstancedLod", async () => {
    const impostor: Impostor = {
      version: 4,
      layout: "full",
      frames: 4,
      size: 16,
      box: [-1, 0, -1, 1, 2, 1],
      halfSize: 1.5,
      maps: ["base", "normalDepth", "orm"],
      layers: [0, 1, 2].map(() => ({ format: RGBAFormat, mipmaps: [16, 8, 4].map((size) => new Uint8Array(size * size * 4)) })),
    };
    const instanced = new InstancedMesh(new SphereGeometry(1, 64, 32), new MeshStandardMaterial(), 2);
    instanced.setMatrixAt(1, new Matrix4().makeTranslation(3, 0, 0));
    const card = new ImpostorMesh(impostor);
    card.position.x = -3;
    const copy = await simplify(new Group().add(instanced, card), { ratio: 0.1 });
    const [many, same] = copy.children;
    if (!many || !isInstancedMesh(many) || !same || !isImpostorMesh(same)) throw new Error("expected the instanced mesh and the impostor");
    expect(triangles(many.geometry)).toBeLessThan(triangles(instanced.geometry) * 0.15);
    expect(many.count).toBe(2);
    expect(same.impostor).toBe(impostor);
    const lod = new InstancedLod([{ object: sphere() }], gpu);
    const clone = vi.spyOn(lod, "clone");
    const source = new Group().add(sphere(), lod);
    try {
      for (const visible of [true, false]) {
        lod.visible = visible;
        await expect(simplify(source, { ratio: 0.5 })).rejects.toThrow(/InstancedLod/);
        expect(clone).not.toHaveBeenCalled();
      }
    } finally {
      clone.mockRestore();
      lod.dispose();
    }
  });

  it("thins alpha-tested cards whole, spread evenly, preserving their coverage", async () => {
    // 20 x 20 separate quads on a wavy sheet, as a crown's needle cards.
    const positions: number[] = [];
    const index: number[] = [];
    for (let i = 0; i < 400; i++) {
      const [x, y] = [(i % 20) - 9.5, Math.floor(i / 20) - 9.5];
      const z = Math.sin(x) * Math.cos(y);
      const v = positions.length / 3;
      for (const [dx, dy] of [
        [0, 0],
        [0.4, 0],
        [0.4, 0.4],
        [0, 0.4],
      ])
        positions.push(x + (dx ?? 0), y + (dy ?? 0), z);
      index.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    const geometry = new BufferGeometry().setAttribute("position", new BufferAttribute(new Float32Array(positions), 3)).setIndex(index);
    geometry.computeVertexNormals();
    const needles = new MeshStandardMaterial({ map: new DataTexture(new Uint8Array(4).fill(255), 1, 1), alphaTest: 0.5 });
    const source = new Mesh(geometry, needles);
    const copy = await simplify(source, { ratio: 0.05 });
    if (!isMesh(copy)) throw new Error("expected a mesh");
    const thinned = copy.geometry;
    const surface = (g: BufferGeometry) =>
      area({ positions: Float32Array.from(g.getAttribute("position").array), index: Uint32Array.from(must(g.index).array), normals: new Float32Array() });
    // About 5% of the 400 cards (meshopt's point simplifier returns at most its target), each whole.
    expect(triangles(thinned) / 2).toBeGreaterThanOrEqual(15);
    expect(triangles(thinned) / 2).toBeLessThanOrEqual(20);
    expect(triangles(thinned) % 2).toBe(0);
    expect(surface(thinned) / surface(geometry)).toBeCloseTo(1, 2);
    // Every quarter of the sheet retains its share; a quad's six corners average to its centre.
    const corner = (i: number, axis: number) => thinned.getAttribute("position").getComponent(must(thinned.index).getX(i), axis);
    const centres = Array.from({ length: triangles(thinned) / 2 }, (_, c) =>
      [0, 1].map((axis) => Array.from({ length: 6 }, (_, k) => corner(c * 6 + k, axis)).reduce((sum, v) => sum + v) / 6),
    );
    for (const [sx, sy] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      expect(centres.filter(([x = 0, y = 0]) => Math.sign(x) === sx && Math.sign(y) === sy).length).toBeGreaterThanOrEqual(3);
    }
    // A level must stay inside its source's bounds, though the cards at the edge grow too.
    const bounds = new Box3().setFromObject(source).expandByScalar(1e-6);
    for (const level of [copy, await simplify(source, { ratio: 0.5 })]) expect(bounds.containsBox(new Box3().setFromObject(level))).toBe(true);
    expect(deviation(source, copy)).toBeGreaterThan(0);
  });

  it("measures a source whose cut-out textures the CPU cannot read, as opaque", async () => {
    const leaves = new MeshStandardMaterial({ map: new CompressedTexture([], 4, 4), alphaTest: 0.5 });
    const copy = await simplify(new Mesh(new BoxGeometry(1, 1, 1, 8, 8, 8), leaves), { ratio: 0.5 });
    expect(isMesh(copy)).toBe(true);
  });
});

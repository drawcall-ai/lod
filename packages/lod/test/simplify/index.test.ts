import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RGBAFormat,
  SphereGeometry,
  type Object3D,
} from "three";
import { describe, expect, it, vi } from "vitest";
import type { Impostor } from "../../src/impostor/impostor.js";
import { ImpostorMesh } from "../../src/impostor/mesh/index.js";
import { Lod } from "../../src/lod.js";
import { simplify } from "../../src/simplify/index.js";
import { isImpostorMesh, isInstancedMesh, isMesh } from "../../src/three.js";
import { area } from "../../src/source/surface.js";
import { must } from "../must.js";

const triangles = (geometry: BufferGeometry) => (geometry.index?.count ?? 0) / 3;
const meshes = (root: Object3D) => root.children.filter(isMesh);
const sphere = (material = new MeshStandardMaterial()) => new Mesh(new SphereGeometry(1, 64, 32), material);

describe("simplify", () => {
  it("reduces triangles and shares the materials and geometry the source shares", async () => {
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
    await expect(simplify(source, { ratio: 0 })).rejects.toThrow(/ratio/);
  });

  it("simplifies an InstancedMesh's geometry, leaves ImpostorMeshes as they are and refuses a Lod", async () => {
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
    const lod = new Lod([{ object: sphere() }]);
    const clone = vi.spyOn(lod, "clone");
    const source = new Group().add(sphere(), lod);
    try {
      for (const visible of [true, false]) {
        lod.visible = visible;
        await expect(simplify(source, { ratio: 0.5 })).rejects.toThrow(/cannot simplify a Lod/);
        expect(clone).not.toHaveBeenCalled();
      }
    } finally {
      clone.mockRestore();
      lod.dispose();
    }
  });

  it("removes interior triangles of a retained foliage card at its specified screen size", async () => {
    const material = new MeshStandardMaterial({ map: new DataTexture(), alphaTest: 0.5 });
    const source = new Mesh(new PlaneGeometry(2, 2, 12, 12), material);
    const original = await simplify(source, { ratio: 0.5 });
    const fitted = await simplify(source, { ratio: 0.5, maxPixels: 900 });
    if (!isMesh(original) || !isMesh(fitted)) throw new Error("expected meshes");
    expect(triangles(fitted.geometry)).toBeLessThan(triangles(original.geometry) / 2);
    expect(new Box3().setFromObject(fitted)).toEqual(new Box3().setFromObject(original));
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
  });
});

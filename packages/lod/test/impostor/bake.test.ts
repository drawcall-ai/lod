import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  PlaneGeometry,
  RGBAFormat,
  SRGBColorSpace,
  IcosahedronGeometry,
  SphereGeometry,
  TorusKnotGeometry,
  type Object3D,
} from "three";
import { describe, expect, it } from "vitest";
import { bakeImpostor } from "../../src/impostor/bake/index.js";
import type { Impostor } from "../../src/impostor/impostor.js";
import { frameDirection } from "../../src/impostor/octahedral.js";
import { ImpostorMesh } from "../../src/impostor/mesh/index.js";
import { InstancedLod } from "../../src/instanced/index.js";
import { GPU_TIMEOUT, renderer } from "../webgl.js";

const bake = (object: Object3D, layout: Impostor["layout"] = "full") => bakeImpostor(object, { renderer, layout, resolution: 32 });

/** Mip level `m` of the base layer. */
const base = (impostor: Impostor, m = 0) => {
  const level = impostor.layers[0]?.[m];
  if (!level) throw new Error(`no base level ${m}`);
  return level;
};

/** Share of atlas texels with any coverage. */
const coverage = (impostor: Impostor) => {
  const level = base(impostor);
  let covered = 0;
  for (let i = 3; i < level.length; i += 4) if (level[i] !== 0) covered++;
  return covered / (level.length / 4);
};

/** Mean red of the covered texels of base mip level `m`. */
const red = (impostor: Impostor, m: number) => {
  const level = base(impostor, m);
  let sum = 0;
  let covered = 0;
  for (let i = 0; i < level.length; i += 4) if (level[i + 3] !== 0) [sum, covered] = [sum + (level[i] ?? 0), covered + 1];
  return sum / covered;
};

/**
 * Per frame of mip level `m` (`frames` square cells), the texel at the cell's centre:
 * the frame's direction, its coverage, decoded normal and front share.
 */
const centres = (impostor: Impostor, m: number) => {
  const [colour, normalDepth, orm] = [0, 1, 2].map((i) => impostor.layers[i]?.[m]);
  if (!colour || !normalDepth || !orm) throw new Error(`no level ${m}`);
  const size = impostor.size >> m;
  const cell = size / impostor.frames;
  return Array.from({ length: impostor.frames ** 2 }, (_, f) => {
    const [col, row] = [f % impostor.frames, Math.floor(f / impostor.frames)];
    const i = ((row * cell + Math.floor(cell / 2)) * size + col * cell + Math.floor(cell / 2)) * 4;
    const normal = [0, 1, 2].map((k) => (normalDepth[i + k] ?? 0) / 127.5 - 1);
    return { direction: frameDirection(impostor.layout, impostor.frames, col, row), cover: colour[i + 3] ?? 0, normal, front: (orm[i + 3] ?? 0) / 255 };
  });
};
const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

describe("bakeImpostor", { timeout: GPU_TIMEOUT }, () => {
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

  it("stores the normals three shades with: turned around for the share in orm.a", async () => {
    // A two-sided card with its own normals, which three turns toward the camera, and one
    // painted to face away from its front, which three turns away on either side.
    const real = new PlaneGeometry(2, 2);
    const painted = real.clone();
    const normals = painted.getAttribute("normal");
    for (let i = 0; i < normals.count; i++) normals.setZ(i, -normals.getZ(i));
    for (const [geometry, toCamera] of [
      [real, 1],
      [painted, -1],
    ] as const) {
      const seen = centres(await bake(new Mesh(geometry, new MeshStandardMaterial({ side: DoubleSide }))), 0);
      const facing = seen.filter((c) => c.cover > 0 && Math.abs(c.direction[2]) > 0.5);
      expect(facing.length).toBeGreaterThan(4);
      for (const c of facing) expect(toCamera * (c.front * 2 - 1) * dot(c.normal, c.direction)).toBeGreaterThan(0.45);
    }
  });

  it("keeps leaves facing every which way from cancelling out", async () => {
    // Strips far narrower than a texel's samples, at irregular widths, each facing +z or -z
    // at random as real leaves do: three turns all of them toward the camera, while their
    // own normals cancel out wherever a texel's samples hit both.
    const positions: number[] = [];
    const normals: number[] = [];
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let a = -1; a < 1;) {
      const b = Math.min(1, a + 0.002 + random() * 0.01);
      const up = random() < 0.5;
      const quad = up ? [a, -1, b, -1, b, 1, a, -1, b, 1, a, 1] : [a, -1, a, 1, b, 1, a, -1, b, 1, b, -1];
      for (let v = 0; v < 6; v++) {
        positions.push(quad[v * 2] ?? 0, quad[v * 2 + 1] ?? 0, 0);
        normals.push(0, 0, up ? 1 : -1);
      }
      a = b;
    }
    const geometry = new BufferGeometry()
      .setAttribute("position", new Float32BufferAttribute(positions, 3))
      .setAttribute("normal", new Float32BufferAttribute(normals, 3));
    const strips = new Mesh(geometry, new MeshStandardMaterial({ side: DoubleSide }));
    const seen = centres(await bakeImpostor(strips, { renderer, resolution: 32, supersample: 4 }), 0);
    const facing = seen.filter((c) => c.cover > 0 && Math.abs(c.direction[2]) > 0.5);
    expect(facing.length).toBeGreaterThan(4);
    // how much of the shading normal (+-z, toward the camera) is left, on average
    const kept = facing.reduce((sum, c) => sum + ((c.front * 2 - 1) * dot(c.normal, c.direction)) / Math.abs(c.direction[2]), 0) / facing.length;
    expect(kept).toBeGreaterThan(0.95);
  });

  it("keeps how far the normals it averages agree as the normal's length", async () => {
    const facets = await bake(new Mesh(new IcosahedronGeometry(1, 1), new MeshStandardMaterial({ flatShading: true })));
    const length = (c: { normal: number[] }) => Math.hypot(...c.normal);
    // Up close a texel sees one facet; one texel per frame sees half the ball.
    for (const c of centres(facets, 0)) expect(length(c)).toBeGreaterThan(0.95);
    const last = (facets.layers[0]?.length ?? 1) - 1;
    for (const c of centres(facets, last)) expect(length(c)).toBeLessThan(0.85);
  });

  it("ignores the material's blending: additive bakes the same atlas", async () => {
    const make = (blending?: typeof AdditiveBlending) =>
      new Mesh(new SphereGeometry(1, 16, 8), new MeshStandardMaterial({ color: 0x3080c0, ...(blending ? { blending } : {}) }));
    const [normal, additive] = await Promise.all([bake(make()), bake(make(AdditiveBlending))]);
    normal.layers.forEach((layer, i) => layer.forEach((level, m) => expect(Buffer.compare(level, additive.layers[i]?.[m] ?? new Uint8Array())).toBe(0)));
  });

  it("renders every mip level at its own size, where the source may look different", async () => {
    // A texture whose own mip levels darken, as leaves with dark texels around them do.
    const mipmaps = Array.from({ length: 9 }, (_, m) => {
      const size = 256 >> m;
      const data = new Uint8Array(size * size * 4).fill(255 - 28 * m);
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
      return { data, width: size, height: size };
    });
    const map = new DataTexture(mipmaps[0]?.data, 256, 256, RGBAFormat);
    map.mipmaps = mipmaps;
    map.generateMipmaps = false;
    map.minFilter = LinearMipmapLinearFilter;
    map.needsUpdate = true;
    const impostor = await bake(new Mesh(new PlaneGeometry(2, 2), new MeshStandardMaterial({ map, side: DoubleSide })), "hemi");
    // Filtered from level 0, every level would keep its brightness.
    expect(red(impostor, 0) - red(impostor, 3)).toBeGreaterThan(40);
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

  it("bakes glass as a dark opaque pane, not a hole, and keeps a blended texture's cut-out", async () => {
    const glass = await bake(
      new Mesh(new PlaneGeometry(2, 2), new MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, side: DoubleSide })),
    );
    expect(coverage(glass)).toBeGreaterThan(0.2);
    const level = base(glass);
    const covered = level.filter((_, i) => i % 4 === 3 && level[i] !== 0);
    // Inside the pane, whole; only the silhouette's edge texels are partial.
    expect(covered.filter((a) => a === 255).length / covered.length).toBeGreaterThan(0.8);
    // 0.25 of white, as sRGB.
    expect(Math.abs(red(glass, 0) - 137)).toBeLessThan(8);
    const data = new Uint8Array(4 * 4 * 4).fill(255);
    for (let i = 0; i < 8; i++) data[i * 4 + 3] = 0;
    const map = new DataTexture(data, 4, 4, RGBAFormat);
    map.needsUpdate = true;
    const half = await bake(new Mesh(new PlaneGeometry(2, 2), new MeshStandardMaterial({ map, transparent: true, opacity: 0.5, side: DoubleSide })));
    expect(coverage(half)).toBeLessThan(coverage(glass) * 0.75);
  });

  it("rejects bad options and objects without extent", async () => {
    const knot = new Mesh(new TorusKnotGeometry(), new MeshStandardMaterial());
    await expect(bakeImpostor(knot, { renderer, frames: 1 })).rejects.toThrow(/frames/);
    await expect(bakeImpostor(knot, { renderer, resolution: 0 })).rejects.toThrow(/resolution/);
    await expect(bakeImpostor(knot, { renderer, supersample: 1.5 })).rejects.toThrow(/supersample/);
    const point = new BufferGeometry().setAttribute("position", new Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
    await expect(bakeImpostor(new Mesh(point, new MeshStandardMaterial()), { renderer })).rejects.toThrow(/no extent/);
  });

  it("bakes an InstancedLod with every instance at full detail, as the same meshes placed by hand", async () => {
    const material = new MeshStandardMaterial({ color: 0x40a060 });
    const spots = [new Matrix4().makeTranslation(-1.5, 0, 0), new Matrix4().makeTranslation(1.5, 0.5, 0), new Matrix4().makeTranslation(0, 0, 1.5)];
    const plain = new Group();
    for (const spot of spots) {
      const box = new Mesh(new BoxGeometry(), material);
      box.applyMatrix4(spot);
      plain.add(box);
    }
    // Its level 1 would draw a sphere, at any height.
    const field = new InstancedLod([new Mesh(new BoxGeometry(), material), new Mesh(new SphereGeometry(), material)], spots.length);
    spots.forEach((spot, i) => field.setMatrixAt(i, spot));
    field.forceLevel = 1;
    const [a, b] = [await bake(plain), await bake(new Group().add(field))];
    expect(b.box).toEqual(a.box);
    const [left, right] = [base(a), base(b)];
    let differing = 0;
    for (let i = 0; i < left.length; i++) if (Math.abs((left[i] ?? 0) - (right[i] ?? 0)) > 8) differing++;
    expect(differing / left.length).toBeLessThan(0.01);
  });

  it("refuses ImpostorMeshes, which have no surface to bake", async () => {
    const impostor = await bake(new Mesh(new SphereGeometry(), new MeshStandardMaterial()));
    await expect(bake(new Group().add(new ImpostorMesh(impostor)))).rejects.toThrow(/ImpostorMesh/);
  });
});

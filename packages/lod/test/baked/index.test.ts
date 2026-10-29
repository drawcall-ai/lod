import {
  AmbientLight,
  BoxGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  Group,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  type BufferGeometry,
  type Object3D,
} from "three/webgpu";
import { describe, expect, it } from "vitest";
import { bakeMesh } from "../../src/baked/index.js";
import type { Impostor } from "../../src/impostor/impostor.js";
import { ImpostorMesh } from "../../src/impostor/mesh/index.js";
import { InstancedLod } from "../../src/instanced/index.js";
import { Lod } from "../../src/lod.js";
import { must } from "../must.js";
import { isStandardNode } from "../../src/three.js";
import { GPU_TIMEOUT, render as draw } from "../gpu.js";

/** A pattern of 8×8 colour blocks. */
function blocks(): DataTexture {
  const data = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < 64; i++) data.set([(i * 37) % 256, (i * 91) % 256, (i * 53 + 80) % 256, 255], i * 4);
  const map = new DataTexture(data, 8, 8, RGBAFormat);
  map.colorSpace = SRGBColorSpace;
  map.magFilter = LinearFilter;
  map.needsUpdate = true;
  return map;
}

const textured = (geometry: BufferGeometry) => new Mesh(geometry, new MeshStandardMaterial({ map: blocks(), roughness: 0.7 }));

/** `object` lit from one side, seen from `eye`, as RGBA pixels on a transparent background. */
function render(object: Object3D, eye: [number, number, number]): Promise<Uint8Array> {
  const sun = new DirectionalLight(0xffffff, 2);
  sun.position.set(1, 2, 3);
  const scene = new Scene().add(object, sun, new AmbientLight(0xffffff, 0.5));
  const camera = new PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(...eye);
  camera.lookAt(0, 0, 0);
  return draw(scene, camera).finally(() => scene.remove(object));
}

/** Mean difference of the colour channels, in 8-bit steps, over the pixels `real` covers. */
function difference(real: Uint8Array, fake: Uint8Array): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < real.length; i += 4) {
    if (real[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) sum += Math.abs((real[i + c] ?? 0) - (fake[i + c] ?? 0));
    count += 3;
  }
  return sum / count;
}

/** The baked base colour pixels of `mesh`. */
function colors(mesh: Mesh): Uint8Array {
  const { material } = mesh;
  if (Array.isArray(material) || !isStandardNode(material) || !(material.map instanceof DataTexture)) throw new Error("expected a baked material");
  const { data } = material.map.image;
  if (!(data instanceof Uint8Array)) throw new Error("expected 8-bit pixels");
  return data;
}

const EYES: Array<[number, number, number]> = [
  [2, 1.5, 2.5],
  [-2.5, 1, 1.5],
  [0.5, -2, -2.5],
];

describe("bakeMesh", { timeout: GPU_TIMEOUT }, () => {
  it("bakes a mesh that renders like its source, and sets its default maxPixels from its deviation", async () => {
    const source = textured(new BoxGeometry(1, 1, 1, 6, 6, 6));
    const baked = await bakeMesh(source, { textureSize: 256 });
    expect(baked.geometry.index?.count).toBeLessThan((source.geometry.index?.count ?? 0) / 4);
    for (const eye of EYES) {
      const real = await render(source, eye);
      // A plain grey box is off by 7 to 23 here.
      expect(difference(real, await render(baked, eye))).toBeLessThan(5);
    }
    expect(new Lod([{ object: source }, { object: baked }]).levels[1]?.maxPixels).not.toBe(512);
  });

  it("keeps the textures of a source in which some meshes have no UVs", async () => {
    const plain = new BoxGeometry(0.3, 0.3, 0.3);
    plain.deleteAttribute("uv");
    const corner = new Mesh(plain, new MeshStandardMaterial({ color: 0x806040 }));
    corner.position.set(0.6, 0.6, 0.6);
    const source = new Group().add(textured(new BoxGeometry(1, 1, 1, 6, 6, 6)), corner);
    const baked = await bakeMesh(source, { textureSize: 256 });
    for (const eye of EYES) expect(difference(await render(source, eye), await render(baked, eye))).toBeLessThan(6);
  });

  it("keeps a low mesh's own UVs when they are usable, and unwraps it again when they overlap", async () => {
    const source = textured(new PlaneGeometry(1, 1, 8, 8));
    const plane = new PlaneGeometry(1, 1);
    const kept = await bakeMesh(source, { low: new Mesh(plane), textureSize: 64 });
    expect(kept.geometry.getAttribute("uv").array).toEqual(plane.getAttribute("uv").array);

    // Every face of a box spans all of 0..1.
    const box = new BoxGeometry(1, 1, 1);
    const unwrapped = await bakeMesh(textured(new BoxGeometry(1, 1, 1, 4, 4, 4)), { low: new Mesh(box), textureSize: 64 });
    expect(unwrapped.geometry.getAttribute("uv").array).not.toEqual(box.getAttribute("uv").array);
  });

  it("bakes every instance of an InstancedLod or an InstancedMesh, as the same meshes placed by hand", async () => {
    const geometry = new BoxGeometry(1, 1, 1, 3, 3, 3);
    const material = new MeshStandardMaterial({ map: blocks() });
    const spots = [new Matrix4().makeTranslation(-1, 0, 0), new Matrix4().makeRotationY(0.5).setPosition(1, 0.3, 0), new Matrix4().makeTranslation(0, 0, 1.2)];
    const plain = new Group();
    for (const spot of spots) {
      const box = new Mesh(geometry, material);
      box.matrixAutoUpdate = false;
      // Instances keep their matrices in 32-bit floats: so do these, for an exact match.
      box.matrix.fromArray(Float32Array.from(spot.elements));
      plain.add(box);
    }
    const lod = new InstancedLod([{ object: new Mesh(geometry, material) }, { object: new Mesh(new SphereGeometry(), material) }], spots.length);
    const instanced = new InstancedMesh(geometry, material, spots.length);
    spots.forEach((spot, i) => (lod.setMatrixAt(i, spot), instanced.setMatrixAt(i, spot)));
    const low = () => new Mesh(new BoxGeometry(3.2, 1.6, 3.2));
    const expected = colors(await bakeMesh(plain, { low: low(), textureSize: 64 }));
    expect(colors(await bakeMesh(new Group().add(lod), { low: low(), textureSize: 64 }))).toEqual(expected);
    expect(colors(await bakeMesh(instanced, { low: low(), textureSize: 64 }))).toEqual(expected);
  });

  it("refuses ImpostorMeshes, which have no surface to read", async () => {
    const impostor: Impostor = {
      version: 3,
      layout: "full",
      frames: 4,
      size: 16,
      box: [-1, 0, -1, 1, 2, 1],
      halfSize: 1.5,
      maps: ["base", "normalDepth", "orm"],
      layers: [0, 1, 2].map(() => [16, 8, 4].map((size) => new Uint8Array(size * size * 4))),
    };
    await expect(bakeMesh(new Group().add(textured(new BoxGeometry()), new ImpostorMesh(impostor)))).rejects.toThrow(/ImpostorMesh/);
  });

  it("bakes normals that turn with an instance: a rotated InstancedLod copy looks like a rotated Lod", async () => {
    const baked = await bakeMesh(textured(new BoxGeometry(1, 1, 1, 4, 4, 4)), { textureSize: 128 });
    const turn = new Matrix4().makeRotationY(Math.PI / 2);
    const lod = new Lod([{ object: new Mesh(new BoxGeometry()) }, { object: baked.clone() }]);
    lod.forceLevel = 1;
    lod.quaternion.setFromRotationMatrix(turn);
    const instanced = new InstancedLod([{ object: new Mesh(new BoxGeometry()) }, { object: baked.clone() }], 1);
    instanced.forceLevel = 1;
    instanced.setMatrixAt(0, turn);
    const eye: [number, number, number] = [2, 1.5, 2.5];
    expect(difference(await render(lod, eye), await render(instanced, eye))).toBeLessThan(1);
  });

  it("keeps a cut-out's coverage in the distance", async () => {
    // Sparse opaque cells, about 30%, like leaves: plain mips average them below the alpha test.
    const data = new Uint8Array(32 * 32 * 4).fill(255);
    let seed = 1;
    for (let i = 0; i < 32 * 32; i++) data[i * 4 + 3] = (seed = (seed * 16807) % 2147483647) / 2147483647 < 0.3 ? 255 : 0;
    const map = new DataTexture(data, 32, 32, RGBAFormat);
    map.needsUpdate = true;
    const plane = new PlaneGeometry(1, 1);
    const source = new Mesh(plane, new MeshStandardMaterial({ map, alphaTest: 0.5 }));
    const baked = await bakeMesh(source, { low: new Mesh(plane), textureSize: 64 });
    const covered = (pixels: Uint8Array) => pixels.filter((_, i) => i % 4 === 3 && pixels[i] !== 0).length;
    // About 8 px across. One nearest-filtered source view aliases badly: compare
    // coverage over subpixel phases, while the baked map samples its 8×8 mip.
    const pixel = (2 * Math.tan((20 * Math.PI) / 180) * 11) / 64;
    let far = 0;
    let reference = 0;
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        source.position.set((x / 4) * pixel, (y / 4) * pixel, 0);
        baked.position.copy(source.position);
        far += covered(await render(baked, [0, 0, 11]));
        reference += covered(await render(source, [0, 0, 11]));
      }
    expect(reference).toBeGreaterThan(160);
    expect(Math.abs(far - reference) / reference).toBeLessThan(0.35);
  });

  it("bakes what shows through the gaps of an open source, not the surface nearest the gap", async () => {
    // A canopy over half of the low plane, and far below the other half (beyond the
    // rays' first reach) the ground under the gap.
    const half = (color: number, y: number, cut = false) => {
      const material = new MeshStandardMaterial({ color, alphaTest: cut ? 0.5 : 0 });
      return new Mesh(new PlaneGeometry(1, 2).rotateX(-Math.PI / 2).translate(-0.5, y, 0), material);
    };
    const ground = half(0x0000ff, -1.5);
    ground.position.x = 1;
    const low = () => new Mesh(new PlaneGeometry(2, 2).rotateX(-Math.PI / 2));
    /** Mean RGBA of the baked texels over x > 0.6, the gap's far side. */
    const gap = async (source: Object3D) => {
      const data = colors(await bakeMesh(source, { low: low(), textureSize: 32 }));
      const sum = [0, 0, 0, 0];
      for (let y = 0; y < 32; y++) for (let x = 26; x < 32; x++) for (let c = 0; c < 4; c++) sum[c] = (sum[c] ?? 0) + (data[(y * 32 + x) * 4 + c] ?? 0);
      return sum.map((v) => v / (32 * 6));
    };
    const [r, , b] = await gap(new Group().add(half(0xff0000, 0), ground));
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(50);
    // Where nothing shows through, a cut-out source leaves the texel cut out.
    expect((await gap(half(0xff0000, 0, true)))[3]).toBe(0);
  });

  it("measures its deviation only against source faces seen from outside", async () => {
    // A box open at the bottom (BoxGeometry groups: +x, -x, +y, -y, +z, -z), as the low mesh too.
    const shell = () => {
      const box = new BoxGeometry(2, 2, 2);
      const index = box.index?.array ?? [];
      const kept = box.groups.filter((_, i) => i !== 3).flatMap((g) => Array.from(index.slice(g.start, g.start + g.count)));
      box.setIndex(kept).clearGroups();
      return box;
    };
    const material = new MeshStandardMaterial({ color: 0x8090a0 });
    const plain = new Group().add(new Mesh(shell(), material));
    // The same, with a floor facing up inside it and a double-sided partition.
    const floor = new Mesh(new PlaneGeometry(2, 2), material).rotateX(-Math.PI / 2).translateZ(-0.99);
    const partition = new Mesh(new PlaneGeometry(1.9, 1.9), new MeshStandardMaterial({ side: DoubleSide }));
    const furnished = new Group().add(new Mesh(shell(), material), floor, partition);
    // The deviation, read through the default maxPixels it gives in a Lod: inversely proportional.
    const deviation = async (source: Object3D) =>
      1 / must(new Lod([{ object: source }, { object: await bakeMesh(source, { low: new Mesh(shell()), textureSize: 64 }) }]).levels[1]).maxPixels;
    const [bare, inside] = [await deviation(plain), await deviation(furnished)];
    expect(Math.abs(inside - bare) / bare).toBeLessThan(0.1);
  });
});

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  AmbientLight,
  Box3,
  BufferAttribute,
  BufferGeometry,
  DataArrayTexture,
  DataTexture,
  DoubleSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RGFormat,
  Scene,
  SRGBColorSpace,
  Vector3,
} from "three/webgpu";
import { describe, expect, it } from "vitest";
import { encodeBakedMesh, decodeBakedMesh } from "../../src/baked/codec.js";
import { bakeMesh } from "../../src/baked/index.js";
import { InteriorMaterial } from "../../src/baked/interior/material.js";
import { errorOf, recordError } from "../../src/levels.js";
import { disposeTree } from "../../src/dispose.js";
import { house, interior, low } from "../house.js";

function texture(channels = 4): DataTexture {
  const data = Uint8Array.from({ length: 4 * 4 * channels }, (_, i) => (i * 137) % 256);
  const result = new DataTexture(data, 4, 4);
  if (channels === 2) result.format = RGFormat;
  result.minFilter = LinearMipmapLinearFilter;
  result.magFilter = LinearFilter;
  result.generateMipmaps = true;
  return result;
}

/** The exact bakeMesh storage layout, without needing a GPU to test the file format. */
function fixture(rooms: boolean): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  geometry.setAttribute("normal", new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 1, 0, 0.5, 1]), 2));
  geometry.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2]), 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const map = texture();
  map.colorSpace = SRGBColorSpace;
  map.generateMipmaps = false;
  map.anisotropy = 4;
  map.mipmaps = [4, 2, 1].map((size) => ({ width: size, height: size, data: new Uint8Array(size * size * 4).fill(size * 50) }));
  const normalMap = texture(),
    orm = texture();
  const material = rooms ? new InteriorMaterial() : new MeshStandardNodeMaterial();
  material.setValues({ map, normalMap, aoMap: orm, roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 1, alphaTest: 0.5, side: DoubleSide });
  if (material instanceof InteriorMaterial) {
    const response = new DataArrayTexture(new Uint8Array(2 * 2 * 6 * 4).fill(127), 2, 2, 6);
    response.colorSpace = SRGBColorSpace;
    response.minFilter = LinearMipmapLinearFilter;
    response.magFilter = LinearFilter;
    response.generateMipmaps = true;
    const glow = response.clone();
    material.furnish({ boxes: [new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1))], response, glow, windows: texture(2), span: 2 });
  }
  const mesh = new Mesh(geometry, material);
  mesh.name = "placed baked mesh";
  mesh.position.set(1 / 3, -2, 8);
  mesh.rotation.set(0.2, 0.4, -0.3);
  mesh.scale.set(2, 3, 4);
  mesh.castShadow = mesh.receiveShadow = true;
  recordError(mesh, 1 / 7);
  return mesh;
}

describe("baked mesh codec", () => {
  it("round-trips geometry, cutout mips, room arrays, placement and error without sharing resources", () => {
    for (const rooms of [false, true]) {
      const source = fixture(rooms);
      const bytes = encodeBakedMesh(source);
      // A sliced file must not accidentally read beyond its view.
      const padded = new Uint8Array(bytes.length + 13);
      padded.set(bytes, 7);
      const decoded = decodeBakedMesh(padded.subarray(7, 7 + bytes.length));
      expect(unzipSync(encodeBakedMesh(decoded))).toEqual(unzipSync(bytes));
      expect(errorOf(decoded)).toBe(errorOf(source));
      expect(decoded.geometry.boundingSphere).toEqual(source.geometry.boundingSphere);
      expect(decoded.geometry.attributes.position?.array).not.toBe(source.geometry.attributes.position?.array);
      if (!(decoded.material instanceof MeshStandardNodeMaterial) || !(source.material instanceof MeshStandardNodeMaterial))
        throw new Error("expected standard material");
      expect(decoded.material.aoMap).toBe(decoded.material.roughnessMap);
      expect(decoded.material.aoMap).toBe(decoded.material.metalnessMap);
      expect(decoded.material.map).not.toBe(source.material.map);
      if (decoded.material instanceof InteriorMaterial && source.material instanceof InteriorMaterial) {
        expect(decoded.material.rooms?.response.image.data).not.toBe(source.material.rooms?.response.image.data);
        expect(decoded.material.rooms?.boxes).toEqual(source.material.rooms?.boxes);
      }
      disposeTree(source);
      disposeTree(decoded);
    }
  });

  it("rejects non-baked/modified input and corrupt geometry, texture data or metadata", () => {
    expect(() => encodeBakedMesh(new Mesh())).toThrow(/bakeMesh result/);
    const source = fixture(false);
    if (!(source.material instanceof MeshStandardNodeMaterial)) throw new Error("expected standard material");
    source.material.normalScale.setScalar(0.6);
    expect(() => encodeBakedMesh(source)).toThrow(/normalScale/);
    source.material.normalScale.setScalar(1);
    const bytes = encodeBakedMesh(source);
    for (const corrupt of ["index", "map/0", "meta"]) {
      const files = unzipSync(bytes);
      if (corrupt === "meta") {
        const meta = files.meta;
        if (!meta) throw new Error("missing metadata");
        files.meta = strToU8(strFromU8(meta).replace('"version":1', '"version":999'));
      } else files[corrupt] = new Uint8Array(1);
      expect(() => decodeBakedMesh(zipSync(files))).toThrow(/Invalid baked mesh/);
    }
    disposeTree(source);
  });

  it.skipIf(typeof document === "undefined")(
    "renders decoded real interior and cutout bakes identically",
    async () => {
      const { render } = await import("../gpu.js");
      const rooms = interior();
      const building = await bakeMesh(house().add(rooms), { low: low(), textureSize: 32, interior: rooms });
      const alpha = texture();
      const data: unknown = alpha.image.data;
      if (!(data instanceof Uint8Array)) throw new Error("expected pixels");
      for (let i = 3; i < data.length; i += 4) data[i] = i % 3 === 0 ? 0 : 255;
      const plane = new Mesh(new PlaneGeometry(2, 2), new MeshStandardMaterial({ map: alpha, alphaTest: 0.5, side: DoubleSide }));
      const cutout = await bakeMesh(plane, { low: plane, textureSize: 32 });
      const camera = new PerspectiveCamera(35, 1, 0.1, 50);
      camera.position.set(2, 0.5, 5);
      camera.lookAt(0, 0, 0);
      const scene = new Scene().add(new AmbientLight(0xffffff, 2));
      for (const original of [building, cutout]) {
        const restored = decodeBakedMesh(encodeBakedMesh(original));
        scene.add(original);
        const before = await render(scene, camera);
        scene.remove(original).add(restored);
        const after = await render(scene, camera);
        scene.remove(restored);
        expect(after).toEqual(before);
        disposeTree(original);
        disposeTree(restored);
      }
    },
    120_000,
  );
});

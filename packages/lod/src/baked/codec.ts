import { Box3, BufferAttribute, BufferGeometry, DoubleSide, FrontSide, Mesh, MeshStandardNodeMaterial, Sphere, Vector3 } from "three/webgpu";
import { pack, unpack } from "../container.js";
import { deviationOf, recordDeviation } from "../levels.js";
import { boolean, fail, file, number, numbers, object, type Files } from "./fields.js";
import { InteriorMaterial } from "./interior/material.js";
import { readTexture, writeTexture } from "./textures.js";

/**
 * Encode an unmodified `bakeMesh` result, before adding it to a Lod or changing its
 * materials. This is a baked-result format, not an Object3D/NodeMaterial serializer.
 * Geometry, map bytes (including cutout mips), rooms, placement and LOD deviation survive
 * exactly. Decoding owns fresh resources; the input mesh remains owned by its caller.
 */
export async function encodeBakedMeshAsync(mesh: Mesh): Promise<Uint8Array> {
  const deviation = deviationOf(mesh);
  const { geometry, material } = mesh;
  if (deviation === undefined || !(deviation >= 0) || !Number.isFinite(deviation)) fail("expected a bakeMesh result with its LOD deviation");
  if (
    mesh.children.length ||
    !mesh.matrixAutoUpdate ||
    !mesh.visible ||
    mesh.renderOrder !== 0 ||
    mesh.layers.mask !== 1 ||
    geometry.groups.length ||
    Object.keys(geometry.morphAttributes).length ||
    geometry.drawRange.start !== 0 ||
    geometry.drawRange.count !== Infinity
  )
    fail("modified baked geometry");
  if (
    !(material instanceof MeshStandardNodeMaterial) ||
    (Object.getPrototypeOf(material) !== MeshStandardNodeMaterial.prototype && Object.getPrototypeOf(material) !== InteriorMaterial.prototype)
  )
    fail("unsupported material");
  const standard = new MeshStandardNodeMaterial();
  // Only the maps, side and alphaTest differ from a default baked material. Refuse
  // shader hooks and material changes rather than silently dropping them from a cache.
  const allowed = new Set([
    "uuid",
    "id",
    "version",
    "_listeners",
    "map",
    "normalMap",
    "aoMap",
    "roughnessMap",
    "metalnessMap",
    "roughness",
    "metalness",
    "alphaTest",
    "_alphaTest",
    "side",
    "rooms",
    "bounds",
    "isInteriorMaterial",
  ]);
  for (const [key, value] of Object.entries(material)) {
    if (allowed.has(key)) continue;
    const expected: unknown = Reflect.get(standard, key);
    if (typeof value === "function" ? value !== expected : JSON.stringify(value) !== JSON.stringify(expected)) fail(`modified material.${key}`);
  }
  if (
    material.roughness !== 1 ||
    material.metalness !== 1 ||
    ![0, 0.5].includes(material.alphaTest) ||
    (material.side !== FrontSide && material.side !== DoubleSide) ||
    material.aoMap !== material.roughnessMap ||
    material.aoMap !== material.metalnessMap
  )
    fail("modified baked material");
  if (Object.keys(geometry.attributes).sort().join() !== "normal,position,uv") fail("unsupported geometry attributes");
  const files: Files = {};
  for (const [name, size] of [
    ["position", 3],
    ["normal", 3],
    ["uv", 2],
  ] as const) {
    const attribute = geometry.getAttribute(name);
    if (!(attribute instanceof BufferAttribute) || !(attribute.array instanceof Float32Array) || attribute.itemSize !== size || attribute.normalized)
      fail(`unsupported ${name} attribute`);
    files[name] = new Uint8Array(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength);
  }
  const index = geometry.index;
  if (!index || !(index.array instanceof Uint32Array) || index.itemSize !== 1) fail("expected Uint32 indices");
  files.index = new Uint8Array(index.array.buffer, index.array.byteOffset, index.array.byteLength);
  const rooms = material instanceof InteriorMaterial ? (material.rooms ?? fail("unfurnished interior")) : null;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const { boundingBox: box, boundingSphere: sphere } = geometry;
  if (!box || !sphere) fail("missing bounds");
  const meta = {
    version: 4,
    name: mesh.name,
    bounds: [...box.min.toArray(), ...box.max.toArray(), ...sphere.center.toArray(), sphere.radius],
    deviation,
    position: mesh.position.toArray(),
    quaternion: mesh.quaternion.toArray(),
    scale: mesh.scale.toArray(),
    castShadow: mesh.castShadow,
    receiveShadow: mesh.receiveShadow,
    side: material.side,
    alphaTest: material.alphaTest,
    map: writeTexture(files, "map", material.map),
    normal: writeTexture(files, "normal", material.normalMap),
    orm: writeTexture(files, "orm", material.aoMap),
    rooms: rooms && {
      boxes: rooms.boxes.map((box) => [...box.min.toArray(), ...box.max.toArray()]),
      span: rooms.span,
      windows: writeTexture(files, "windows", rooms.windows),
      response: writeTexture(files, "response", rooms.response),
      glow: rooms.glow && writeTexture(files, "glow", rooms.glow),
    },
  };
  return pack({ ...meta, files: Object.keys(files) }, Object.values(files));
}

/** Decode `encodeBakedMeshAsync` bytes into an independently owned mesh, ready for a Lod. */
export async function decodeBakedMeshAsync(bytes: Uint8Array): Promise<Mesh> {
  const contents = await unpack(bytes, fail);
  const meta = object(contents.header);
  if (meta.version !== 4) fail("unsupported version; bake it again");
  const names = meta.files;
  if (!Array.isArray(names) || names.length !== contents.files.length) fail("file names do not match the files");
  const files: Files = Object.fromEntries(
    names.map((name: unknown, i) => [typeof name === "string" ? name : fail("invalid file name"), contents.files[i] ?? fail("missing file")]),
  );
  if (typeof meta.name !== "string") fail("missing name");
  const deviation = number(meta.deviation);
  if (deviation < 0) fail("negative LOD deviation");
  // The container's CRC rejects corrupt bytes, so lengths are checked but values are not walked.
  const position = view(file(files, "position"), Float32Array);
  const normal = view(file(files, "normal"), Float32Array);
  const uv = view(file(files, "uv"), Float32Array);
  const index = view(file(files, "index"), Uint32Array);
  if (!position.length || position.length % 3 || normal.length !== position.length || uv.length * 3 !== position.length * 2 || index.length % 3)
    fail("invalid geometry lengths");
  const bounds = numbers(meta.bounds, 10);
  const side = meta.side === FrontSide ? FrontSide : meta.side === DoubleSide ? DoubleSide : fail("unsupported side");
  const alphaTest = meta.alphaTest === 0 ? 0 : meta.alphaTest === 0.5 ? 0.5 : fail("unsupported alpha test");
  const map = readTexture(files, "map", meta.map, false);
  const normalMap = readTexture(files, "normal", meta.normal, false);
  const orm = readTexture(files, "orm", meta.orm, false);
  const material = meta.rooms === null ? new MeshStandardNodeMaterial() : new InteriorMaterial();
  material.setValues({ map, normalMap, aoMap: orm, roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 1, side, alphaTest });
  if (material instanceof InteriorMaterial) {
    const rooms = object(meta.rooms);
    if (!Array.isArray(rooms.boxes) || !rooms.boxes.length) fail("missing room boxes");
    const boxes = rooms.boxes.map((value) => {
      const box = numbers(value, 6);
      const result = new Box3(new Vector3().fromArray(box), new Vector3().fromArray(box, 3));
      if (result.isEmpty()) fail("empty room");
      return result;
    });
    const response = readTexture(files, "response", rooms.response, true);
    const glow = rooms.glow === null ? null : readTexture(files, "glow", rooms.glow, true);
    if (response.image.depth !== boxes.length * 6 || (glow && glow.image.depth !== response.image.depth)) fail("room texture layer count");
    const windows = readTexture(files, "windows", rooms.windows, false);
    const span = number(rooms.span);
    if (span <= 0) fail("invalid room span");
    material.furnish({ boxes, span, response, glow, windows });
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("normal", new BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.boundingBox = new Box3().setFromArray(bounds.slice(0, 6));
  geometry.boundingSphere = new Sphere(new Vector3().fromArray(bounds, 6), bounds[9]);
  const mesh = new Mesh(geometry, material);
  mesh.name = meta.name;
  mesh.position.fromArray(numbers(meta.position, 3));
  mesh.quaternion.fromArray(numbers(meta.quaternion, 4));
  mesh.scale.fromArray(numbers(meta.scale, 3));
  mesh.castShadow = boolean(meta.castShadow);
  mesh.receiveShadow = boolean(meta.receiveShadow);
  recordDeviation(mesh, deviation);
  return mesh;
}

/** `bytes` as 32-bit values, in place: the container aligns its files. */
function view<T extends Float32Array | Uint32Array>(bytes: Uint8Array, Type: { new (buffer: ArrayBuffer, offset: number, length: number): T }): T {
  if (bytes.byteLength % 4) fail("invalid geometry data length");
  const { buffer, byteOffset, byteLength } = bytes;
  if (!(buffer instanceof ArrayBuffer)) fail("shared geometry data");
  return new Type(buffer, byteOffset, byteLength / 4);
}

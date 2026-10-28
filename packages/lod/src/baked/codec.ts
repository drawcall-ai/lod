import { strFromU8, strToU8, unzip, unzipSync, zipSync } from "fflate";
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataArrayTexture,
  DataTexture,
  DoubleSide,
  FrontSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardNodeMaterial,
  NoColorSpace,
  RGBAFormat,
  RGFormat,
  SRGBColorSpace,
  UnsignedByteType,
  UVMapping,
  Vector3,
  type Texture,
} from "three/webgpu";
import { errorOf, recordError } from "../levels.js";
import { InteriorMaterial } from "./interior/material.js";

type Files = Record<string, Uint8Array>;
function fail(why: string): never {
  throw new Error(`Invalid baked mesh: ${why}`);
}
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("expected metadata object");
  return Object.fromEntries(Object.entries(value));
};
const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : fail("expected finite number"));
const integer = (value: unknown): number => {
  const result = number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : fail("expected positive integer");
};
const boolean = (value: unknown): boolean => (typeof value === "boolean" ? value : fail("expected boolean"));
const numbers = (value: unknown, count: number): number[] => {
  if (!Array.isArray(value) || value.length !== count) fail(`expected ${count} numbers`);
  return value.map(number);
};
const file = (files: Files, name: string): Uint8Array => files[name] ?? fail(`missing ${name}`);

/**
 * Encode an unmodified `bakeMesh` result, before adding it to a Lod or changing its
 * materials. This is a baked-result format, not an Object3D/NodeMaterial serializer.
 * Geometry, map bytes (including cutout mips), rooms, placement and LOD error survive
 * exactly. Decoding owns fresh resources; the input mesh remains owned by its caller.
 */
export function encodeBakedMesh(mesh: Mesh): Uint8Array {
  const error = errorOf(mesh);
  const { geometry, material } = mesh;
  if (error === undefined || !(error >= 0) || !Number.isFinite(error)) fail("expected a bakeMesh result with its LOD error");
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
  const meta = {
    version: 1,
    name: mesh.name,
    error,
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
  files.meta = strToU8(JSON.stringify(meta));
  return zipSync(files, { level: 6 });
}

/** Decode `encodeBakedMesh` bytes into an independently owned mesh, ready for a Lod. */
export function decodeBakedMesh(input: Uint8Array | ArrayBuffer): Mesh {
  const files = unzipSync(input instanceof Uint8Array ? input : new Uint8Array(input));
  return fromFiles(files);
}

/** Inflate large cached entries in fflate workers before constructing their mesh. */
export async function decodeBakedMeshAsync(input: Uint8Array | ArrayBuffer): Promise<Mesh> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const files = await new Promise<Files>((resolve, reject) => unzip(bytes, (error, files) => (error ? reject(error) : resolve(files))));
  return fromFiles(files);
}

function fromFiles(files: Files): Mesh {
  const parsed: unknown = JSON.parse(strFromU8(file(files, "meta")));
  const meta = object(parsed);
  if (meta.version !== 1) fail("unsupported version");
  if (typeof meta.name !== "string") fail("missing name");
  const error = number(meta.error);
  if (error < 0) fail("negative LOD error");
  const position = floats(file(files, "position"));
  const normal = floats(file(files, "normal"));
  const uv = floats(file(files, "uv"));
  const indices = file(files, "index");
  if (!position.length || position.length % 3 || normal.length !== position.length || uv.length * 3 !== position.length * 2 || indices.byteLength % 12)
    fail("invalid geometry lengths");
  const index = new Uint32Array(indices.slice().buffer);
  if (index.some((i) => i >= position.length / 3)) fail("index outside geometry");
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
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, material);
  mesh.name = meta.name;
  mesh.position.fromArray(numbers(meta.position, 3));
  mesh.quaternion.fromArray(numbers(meta.quaternion, 4));
  mesh.scale.fromArray(numbers(meta.scale, 3));
  mesh.castShadow = boolean(meta.castShadow);
  mesh.receiveShadow = boolean(meta.receiveShadow);
  recordError(mesh, error);
  return mesh;
}

function floats(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4) fail("invalid float data length");
  const values = new Float32Array(bytes.slice().buffer);
  if (values.some((value) => !Number.isFinite(value))) fail("non-finite geometry");
  return values;
}

function writeTexture(files: Files, name: string, texture: Texture | null) {
  if (!(texture instanceof DataTexture) && !(texture instanceof DataArrayTexture)) fail(`missing ${name} data texture`);
  const image: unknown = texture.image;
  const base = object(image);
  const width = integer(base.width),
    height = integer(base.height);
  const depth = texture instanceof DataArrayTexture ? integer(base.depth) : 1;
  if (
    texture.type !== UnsignedByteType ||
    (texture.format !== RGBAFormat && texture.format !== RGFormat) ||
    texture.minFilter !== LinearMipmapLinearFilter ||
    texture.magFilter !== LinearFilter ||
    texture.wrapS !== ClampToEdgeWrapping ||
    texture.wrapT !== ClampToEdgeWrapping ||
    texture.flipY ||
    texture.premultiplyAlpha ||
    texture.channel !== 0 ||
    texture.mapping !== UVMapping ||
    !texture.matrixAutoUpdate ||
    texture.internalFormat !== null ||
    texture.offset.x !== 0 ||
    texture.offset.y !== 0 ||
    texture.repeat.x !== 1 ||
    texture.repeat.y !== 1 ||
    texture.rotation !== 0 ||
    (texture.colorSpace !== SRGBColorSpace && texture.colorSpace !== NoColorSpace)
  )
    fail(`unsupported ${name} texture settings`);
  const channels = texture.format === RGFormat ? 2 : 4;
  const pixels = (value: unknown, width: number, height: number) => {
    if (!(value instanceof Uint8Array) || value.byteLength !== width * height * depth * channels) fail(`invalid ${name} pixels`);
    return value;
  };
  files[name + "/0"] = pixels(base.data, width, height);
  const mips = texture.mipmaps.map((value, index) => {
    const mip = object(value);
    const w = integer(mip.width),
      h = integer(mip.height);
    if (w !== Math.max(1, width >> index) || h !== Math.max(1, height >> index)) fail("invalid mip dimensions");
    files[`${name}/mip${index}`] = pixels(mip.data, w, h);
    return [w, h];
  });
  return {
    width,
    height,
    depth,
    channels,
    srgb: texture.colorSpace === SRGBColorSpace,
    anisotropy: texture.anisotropy,
    generateMipmaps: texture.generateMipmaps,
    unpackAlignment: texture.unpackAlignment,
    mips,
  };
}

function readTexture(files: Files, name: string, value: unknown, array: true): DataArrayTexture;
function readTexture(files: Files, name: string, value: unknown, array: false): DataTexture;
function readTexture(files: Files, name: string, value: unknown, array: boolean): DataArrayTexture | DataTexture {
  const meta = object(value);
  const width = integer(meta.width),
    height = integer(meta.height),
    depth = integer(meta.depth);
  const channels = meta.channels === 2 ? 2 : meta.channels === 4 ? 4 : fail("invalid texture channels");
  if (!array && depth !== 1) fail("2D texture with layers");
  const pixels = (key: string, width: number, height: number) => {
    const data = file(files, key);
    if (data.byteLength !== width * height * depth * channels) fail(`invalid ${key} byte length`);
    return data;
  };
  const data = pixels(name + "/0", width, height);
  const texture = array ? new DataArrayTexture(data, width, height, depth) : new DataTexture(data, width, height);
  texture.format = channels === 2 ? RGFormat : RGBAFormat;
  texture.colorSpace = boolean(meta.srgb) ? SRGBColorSpace : NoColorSpace;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = number(meta.anisotropy);
  texture.generateMipmaps = boolean(meta.generateMipmaps);
  const alignment = meta.unpackAlignment;
  if (alignment !== 1 && alignment !== 2 && alignment !== 4 && alignment !== 8) fail("invalid texture alignment");
  texture.unpackAlignment = alignment;
  if (!Array.isArray(meta.mips)) fail("missing mipmaps");
  texture.mipmaps = meta.mips.map((value, index) => {
    const size = numbers(value, 2);
    const w = integer(size[0]),
      h = integer(size[1]);
    if (w !== Math.max(1, width >> index) || h !== Math.max(1, height >> index)) fail("invalid mip dimensions");
    return { data: pixels(`${name}/mip${index}`, w, h), width: w, height: h };
  });
  texture.needsUpdate = true;
  return texture;
}

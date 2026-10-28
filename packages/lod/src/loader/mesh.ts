import { gunzip, gzipSync, strFromU8, strToU8 } from "fflate";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import {
  BufferAttribute,
  BufferGeometry,
  Float16BufferAttribute,
  FloatType,
  Group,
  IntType,
  Mesh,
  Object3D,
  Scene,
  type InterleavedBufferAttribute,
  type LoadingManager,
  type Material,
  type TypedArrayConstructor,
} from "three/webgpu";
import { isInstancedMesh, isLOD, isMesh, isSkinnedMesh } from "../three.js";

export type MaterialResolver = (name: string, data: Record<string, unknown>) => Material | undefined | Promise<Material | undefined>;

let workers = false;
export function gltfLoader(manager: LoadingManager): GLTFLoader {
  if (!workers && MeshoptDecoder.supported) {
    MeshoptDecoder.useWorkers(2);
    workers = true;
  }
  return new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
}

const arrays: Record<string, TypedArrayConstructor> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
};
const containers: Record<string, new () => Object3D> = { Scene, Group, Object3D };

/** Only computed geometry is stored; material slots refer to the source's original objects. */
export function encodeMesh(object: Object3D, materials: readonly Material[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const geometries: BufferGeometry[] = [];
  let length = 0;
  function attribute(value: BufferAttribute | InterleavedBufferAttribute) {
    if (value instanceof Float16BufferAttribute) fail("unsupported float16 attribute");
    const packed = value instanceof BufferAttribute ? value.array : value.array.slice(0, value.count * value.itemSize);
    if (!(value instanceof BufferAttribute))
      for (let i = 0; i < value.count; i++) {
        const offset = i * value.data.stride + value.offset;
        packed.set(value.array.subarray(offset, offset + value.itemSize), i * value.itemSize);
      }
    const offset = length;
    chunks.push(new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength));
    length += packed.byteLength;
    return {
      offset,
      length: packed.byteLength,
      type: packed.constructor.name,
      size: value.itemSize,
      normalized: value.normalized,
      gpuType: value instanceof BufferAttribute ? value.gpuType : FloatType,
    };
  }
  function node(value: Object3D): Record<string, unknown> {
    if (isLOD(value) || isSkinnedMesh(value) || isInstancedMesh(value) || !["Mesh", "Group", "Scene", "Object3D"].includes(value.type))
      fail(`cannot persist ${value.type}; sources must contain static meshes and groups`);
    if (value.matrixAutoUpdate) value.updateMatrix();
    const geometry = isMesh(value) ? value.geometry : undefined;
    if (geometry && !geometries.includes(geometry)) geometries.push(geometry);
    const slot = (material: Material) => {
      const index = materials.indexOf(material);
      if (index < 0) fail(`material "${material.name}" is not in the source`);
      return index;
    };
    return {
      type: value.type,
      name: value.name,
      matrix: value.matrix.toArray(),
      matrixAutoUpdate: value.matrixAutoUpdate,
      matrixWorldAutoUpdate: value.matrixWorldAutoUpdate,
      visible: value.visible,
      castShadow: value.castShadow,
      receiveShadow: value.receiveShadow,
      frustumCulled: value.frustumCulled,
      renderOrder: value.renderOrder,
      layers: value.layers.mask,
      data: value.userData,
      children: value.children.map(node),
      geometry: geometry && geometries.indexOf(geometry),
      material: isMesh(value) ? (Array.isArray(value.material) ? value.material.map(slot) : slot(value.material)) : undefined,
    };
  }
  const root = node(object);
  const geometry = geometries.map((value) => {
    if (Object.keys(value.morphAttributes).length) fail("cannot persist morph targets");
    return {
      name: value.name,
      data: value.userData,
      groups: value.groups.map((group) => [group.start, group.count, group.materialIndex ?? 0]),
      range: [value.drawRange.start, value.drawRange.count === Infinity ? null : value.drawRange.count],
      attributes: Object.fromEntries(Object.entries(value.attributes).map(([name, value]) => [name, attribute(value)])),
      index: value.index && attribute(value.index),
    };
  });
  const header = strToU8(JSON.stringify({ version: 1, root, geometry }));
  const bytes = new Uint8Array(4 + header.length + length);
  new DataView(bytes.buffer).setUint32(0, header.length, true);
  bytes.set(header, 4);
  let offset = 4 + header.length;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return gzipSync(bytes, { level: 1 });
}

export async function decodeMesh(input: Uint8Array, materials: readonly Material[]): Promise<Object3D> {
  const bytes = await new Promise<Uint8Array>((resolve, reject) => gunzip(input, (error, bytes) => (error ? reject(error) : resolve(bytes))));
  if (bytes.length < 4) fail("missing metadata");
  const start = 4 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (start > bytes.length) fail("invalid metadata length");
  const meta = record(JSON.parse(strFromU8(bytes.subarray(4, start))));
  if (meta.version !== 1) fail("unsupported version");
  function attribute(value: unknown): BufferAttribute {
    const meta = record(value);
    const Type = arrays[string(meta.type)] ?? fail("unsupported attribute type");
    const offset = start + integer(meta.offset);
    const length = integer(meta.length);
    const size = integer(meta.size);
    if (!size || length % (Type.BYTES_PER_ELEMENT * size) || offset + length > bytes.length) fail("invalid attribute length");
    const result = new BufferAttribute(new Type(bytes.slice(offset, offset + length).buffer), size, boolean(meta.normalized));
    if (meta.gpuType !== FloatType && meta.gpuType !== IntType) fail("invalid attribute gpuType");
    result.gpuType = meta.gpuType;
    return result;
  }
  const geometries = list(meta.geometry).map((value) => {
    const meta = record(value);
    const geometry = new BufferGeometry();
    geometry.name = string(meta.name);
    geometry.userData = record(meta.data);
    for (const [name, value] of Object.entries(record(meta.attributes))) geometry.setAttribute(name, attribute(value));
    if (meta.index !== null) geometry.setIndex(attribute(meta.index));
    for (const value of list(meta.groups)) {
      const group = list(value);
      geometry.addGroup(integer(group[0]), integer(group[1]), integer(group[2]));
    }
    const range = list(meta.range);
    geometry.setDrawRange(integer(range[0]), range[1] === null ? Infinity : integer(range[1]));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  });
  const material = (value: unknown): Material => materials[integer(value)] ?? fail("missing source material");
  function node(value: unknown): Object3D {
    const meta = record(value);
    const geometry = meta.type === "Mesh" ? (geometries[integer(meta.geometry)] ?? fail("missing geometry")) : undefined;
    const result = geometry
      ? new Mesh(geometry, Array.isArray(meta.material) ? meta.material.map(material) : material(meta.material))
      : new (containers[string(meta.type)] ?? fail("unsupported node type"))();
    result.name = string(meta.name);
    const matrix = list(meta.matrix);
    if (matrix.length !== 16) fail("invalid matrix");
    result.matrix.fromArray(matrix.map(number));
    result.matrix.decompose(result.position, result.quaternion, result.scale);
    for (const key of ["matrixAutoUpdate", "matrixWorldAutoUpdate", "visible", "castShadow", "receiveShadow", "frustumCulled"] as const)
      result[key] = boolean(meta[key]);
    result.renderOrder = number(meta.renderOrder);
    result.layers.mask = number(meta.layers);
    result.userData = record(meta.data);
    for (const child of list(meta.children)) result.add(node(child));
    return result;
  }
  return node(meta.root);
}

function fail(reason: string): never {
  throw new Error(`LodLoader: invalid mesh cache (${reason})`);
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("expected object");
  return Object.fromEntries(Object.entries(value));
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : fail("expected array");
}
function string(value: unknown): string {
  return typeof value === "string" ? value : fail("expected string");
}
function boolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : fail("expected boolean");
}
function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fail("expected finite number");
}
function integer(value: unknown): number {
  const result = number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : fail("expected nonnegative integer");
}

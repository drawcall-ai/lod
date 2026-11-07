import { MeshoptEncoder } from "meshoptimizer";
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Float16BufferAttribute,
  FloatType,
  Group,
  IntType,
  Mesh,
  Object3D,
  Scene,
  Sphere,
  Vector3,
  type InterleavedBufferAttribute,
  type Material,
  type TypedArrayConstructor,
} from "three/webgpu";
import { pack, unpack } from "../container.js";
import { borrowMaterials } from "../dispose.js";
import { meshoptDecoder } from "../meshopt.js";
import { isInstancedMesh, isLOD, isMesh, isSkinnedMesh } from "../three.js";

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

/** Float attributes keep this many of their 24 significant bits: each value moves by at most 2^-17 of its magnitude. */
const BITS = 18;

/**
 * Store a static hierarchy's geometry and material slots. Decode with the same ordered material list; materials and textures are never serialized.
 * Attributes and indices are meshopt-encoded, and float attributes keep `BITS` significant bits, as meshopt's exponential filter stores them.
 */
export async function encodeMeshAsync(object: Object3D, materials: readonly Material[]): Promise<Uint8Array> {
  await MeshoptEncoder.ready;
  const files: Uint8Array[] = [];
  const geometries: BufferGeometry[] = [];
  function attribute(value: BufferAttribute | InterleavedBufferAttribute, index: boolean) {
    if (value instanceof Float16BufferAttribute) fail("unsupported float16 attribute");
    const packed = value instanceof BufferAttribute ? value.array : value.array.slice(0, value.count * value.itemSize);
    if (!(value instanceof BufferAttribute))
      for (let i = 0; i < value.count; i++) {
        const offset = i * value.data.stride + value.offset;
        packed.set(value.array.subarray(offset, offset + value.itemSize), i * value.itemSize);
      }
    const stride = packed.BYTES_PER_ELEMENT * value.itemSize;
    const mode = index ? (stride === 2 || stride === 4 ? (value.count % 3 ? "INDICES" : "TRIANGLES") : null) : stride % 4 || stride > 256 ? null : "ATTRIBUTES";
    const floats = mode === "ATTRIBUTES" && packed instanceof Float32Array ? packed : undefined;
    const bytes = floats
      ? MeshoptEncoder.encodeFilterExp(floats, value.count, stride, BITS, "Separate")
      : new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength);
    files.push(mode ? MeshoptEncoder.encodeGltfBuffer(bytes, value.count, stride, mode, 1) : bytes);
    return {
      file: files.length - 1,
      type: packed.constructor.name,
      count: value.count,
      size: value.itemSize,
      mode,
      filter: floats ? "EXPONENTIAL" : null,
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
      bounds: bounds(value),
      name: value.name,
      data: value.userData,
      groups: value.groups.map((group) => [group.start, group.count, group.materialIndex ?? 0]),
      range: [value.drawRange.start, value.drawRange.count === Infinity ? null : value.drawRange.count],
      attributes: Object.fromEntries(Object.entries(value.attributes).map(([name, value]) => [name, attribute(value, false)])),
      index: value.index && attribute(value.index, true),
    };
  });
  return pack({ version: 3, root, geometry }, files);
}

export async function decodeMeshAsync(input: Uint8Array, materials: readonly Material[]): Promise<Object3D> {
  const { header, files } = await unpack(input, fail);
  const meta = record(header);
  if (meta.version !== 3) fail("unsupported version; encode it again");
  const decoder = meshoptDecoder();
  async function attribute(value: unknown): Promise<BufferAttribute> {
    const meta = record(value);
    const Type = arrays[string(meta.type)] ?? fail("unsupported attribute type");
    const file = files[integer(meta.file)] ?? fail("missing attribute file");
    const count = integer(meta.count);
    const size = integer(meta.size);
    const stride = Type.BYTES_PER_ELEMENT * size;
    const mode = meta.mode === null ? null : string(meta.mode);
    const filter = meta.filter === null ? undefined : string(meta.filter);
    if (!size || (mode === null && file.length !== count * stride)) fail("invalid attribute length");
    const { buffer, byteOffset } = mode === null ? file : await decoder.decodeGltfBufferAsync(count, stride, file, mode, filter);
    if (!(buffer instanceof ArrayBuffer)) fail("shared attribute data");
    const array = new Type(buffer, byteOffset, count * size);
    const result = new BufferAttribute(array, size, boolean(meta.normalized));
    if (meta.gpuType !== FloatType && meta.gpuType !== IntType) fail("invalid attribute gpuType");
    result.gpuType = meta.gpuType;
    return result;
  }
  const geometries = await Promise.all(
    list(meta.geometry).map(async (value) => {
      const meta = record(value);
      const geometry = new BufferGeometry();
      geometry.name = string(meta.name);
      geometry.userData = record(meta.data);
      const attributes = Object.entries(record(meta.attributes));
      const decoded = await Promise.all(attributes.map(([, value]) => attribute(value)));
      attributes.forEach(([name], i) => geometry.setAttribute(name, decoded[i] ?? fail("missing attribute")));
      if (meta.index !== null) geometry.setIndex(await attribute(meta.index));
      for (const value of list(meta.groups)) {
        const group = list(value);
        geometry.addGroup(integer(group[0]), integer(group[1]), integer(group[2]));
      }
      const range = list(meta.range);
      geometry.setDrawRange(integer(range[0]), range[1] === null ? Infinity : integer(range[1]));
      if (meta.bounds !== null) {
        const values = list(meta.bounds).map(number);
        if (values.length !== 10) fail("invalid bounds");
        geometry.boundingBox = new Box3().setFromArray(values.slice(0, 6));
        geometry.boundingSphere = new Sphere(new Vector3().fromArray(values, 6), values[9]);
      }
      return geometry;
    }),
  );
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
  const root = node(meta.root);
  borrowMaterials(root);
  return root;
}

/**
 * The box and sphere three computes from the positions, stored so decode does not walk them; null without positions. They
 * bound the positions before the filter, which may move a vertex out of them by 2^-17 of its coordinates.
 */
function bounds(geometry: BufferGeometry): number[] | null {
  if (!geometry.getAttribute("position")) return null;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const { boundingBox: box, boundingSphere: sphere } = geometry;
  if (!box || !sphere) fail("missing bounds");
  return [...box.min.toArray(), ...box.max.toArray(), ...sphere.center.toArray(), sphere.radius];
}

function fail(reason: string, cause?: unknown): never {
  throw new Error(`Invalid mesh cache (${reason})`, { cause });
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

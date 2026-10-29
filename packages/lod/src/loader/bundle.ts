import { Box3, Group, Matrix4, type Material, type Object3D } from "three/webgpu";
import { decodeBakedMeshAsync, encodeBakedMesh } from "../baked/codec.js";
import { boundingBox } from "../bounds.js";
import { decode as decodeLevel } from "../deferred.js";
import { disposeTree } from "../dispose.js";
import { decodeImpostorAsync, encodeImpostor } from "../impostor/codec.js";
import { ImpostorMesh, type ImpostorMeshOptions } from "../impostor/mesh/index.js";
import { deviationOf, recordDeviation, type LodLevel } from "../levels.js";
import { isImpostorMesh, isMesh } from "../three.js";
import { decodeMesh, encodeMesh, type MaterialResolver } from "./mesh.js";

export type Kind = "mesh" | "baked" | "impostor" | "empty";
type StoredKind = Kind | "source";
interface Metadata {
  kind: StoredKind;
  materials?: Array<{ name: string; data: Record<string, unknown> }>;
  name: string;
  maxPixels: number;
  deviation?: number;
  box: Box3;
  matrix: Matrix4;
  matrixAutoUpdate: boolean;
  draw?: ImpostorMeshOptions;
  castShadow: boolean;
  receiveShadow: boolean;
  length: number;
}

/** Inline coarse derived payloads; a source-only request leaves its source deferred. */
export async function encode(
  objects: readonly Object3D[],
  kinds: readonly StoredKind[],
  thresholds: readonly number[],
  material?: MaterialResolver,
): Promise<{ index: Uint8Array; levels: Array<{ index: number; bytes: Uint8Array }> }> {
  if (kinds[0] !== "source" && kinds.includes("mesh") && !material) throw new Error("LodLoader: procedural meshes need a material resolver");
  const payloads: Uint8Array[] = [];
  const metadata = [];
  let coarsest = -1;
  for (const [index, object] of objects.entries()) {
    const kind = kinds[index];
    if (!kind) throw new Error("LodLoader: missing level kind");
    const box = boundingBox(object);
    const materials = material && kind === "mesh" ? materialsOf(object) : materialsOf(objects[0]);
    const references =
      material && kind === "mesh"
        ? await Promise.all(
            materials.map(async ({ name, userData }) => {
              if (!name || !(await material(name, userData))) throw new Error(`LodLoader: no material for "${name}"`);
              return { name, data: userData };
            }),
          )
        : undefined;
    const bytes = await payload(object, kind, materials);
    if (!box.isEmpty()) coarsest = index;
    if (object.matrixAutoUpdate) object.updateMatrix();
    metadata.push({
      kind,
      materials: references,
      name: object.name,
      maxPixels: index === 0 ? null : thresholds[index],
      deviation: deviationOf(object),
      box: box.isEmpty() ? null : [...box.min.toArray(), ...box.max.toArray()],
      matrix: object.matrix.toArray(),
      matrixAutoUpdate: object.matrixAutoUpdate,
      draw: isImpostorMesh(object) ? object.options : undefined,
      castShadow: object.castShadow,
      receiveShadow: object.receiveShadow,
      length: bytes.byteLength,
    });
    payloads.push(bytes);
  }
  if (coarsest < 0) throw new Error("LodLoader: cache has no drawable level");
  const coarse = coarsest > 0 ? payloads[coarsest] : new Uint8Array();
  if (!coarse) throw new Error("LodLoader: missing coarse payload");
  const header = new TextEncoder().encode(JSON.stringify(metadata));
  const index = new Uint8Array(8 + header.length + coarse.length);
  const view = new DataView(index.buffer);
  view.setUint32(0, 0x32444f4c, true);
  view.setUint32(4, header.length, true);
  index.set(header, 8);
  index.set(coarse, 8 + header.length);
  const levels = payloads.flatMap((bytes, index) => ((index === coarsest && coarsest > 0) || bytes.length === 0 ? [] : [{ index, bytes }]));
  return { index, levels };
}

async function payload(object: Object3D, kind: StoredKind, materials: readonly Material[]): Promise<Uint8Array> {
  switch (kind) {
    case "source":
    case "empty":
      return new Uint8Array();
    case "mesh":
      return encodeMesh(object, materials);
    case "baked":
      if (!isMesh(object)) throw new Error("LodLoader: baked level is not a mesh");
      return encodeBakedMesh(object);
    case "impostor":
      if (!isImpostorMesh(object)) throw new Error("LodLoader: impostor level is not an ImpostorMesh");
      return encodeImpostor(object.impostor);
  }
}

/** Index metadata exposes every drawable level without decoding its payload. */
export function decode(
  bytes: Uint8Array,
  loadSource: (index: number) => Promise<Object3D>,
  loadLevel: (index: number) => Promise<Uint8Array>,
  restore?: (object: Object3D, index: number) => void | Promise<void>,
  material?: MaterialResolver,
): LodLevel[] {
  const { metadata, coarsest, coarse } = read(bytes);
  const resolved = new Map<string, Promise<Material>>();
  const materials = async (level: Metadata): Promise<Material[]> => {
    if (!level.materials) {
      const source = levels[0];
      if (!source) fail("missing source materials");
      return materialsOf(source.object ?? (await decodeLevel(source.load).promise));
    }
    return Promise.all(
      level.materials.map(({ name, data }) => {
        const key = JSON.stringify([name, data]);
        let pending = resolved.get(key);
        if (!pending) {
          pending = Promise.resolve(material?.(name, data)).then((value) => value ?? fail(`no material for "${name}"`));
          resolved.set(key, pending);
        }
        return pending;
      }),
    );
  };
  const levels: LodLevel[] = metadata.map((level, index) => {
    const load = async () => {
      const bytes = level.kind === "source" || level.kind === "empty" ? new Uint8Array() : index === coarsest && coarsest > 0 ? coarse : await loadLevel(index);
      if (bytes.length !== level.length) fail(`level ${index} payload length`);
      const loaded =
        level.kind === "source"
          ? await loadSource(index)
          : level.kind === "empty"
            ? new Group()
            : level.kind === "impostor"
              ? new ImpostorMesh(await decodeImpostorAsync(bytes), 1, level.draw)
              : level.kind === "baked"
                ? await decodeBakedMeshAsync(bytes)
                : await decodeMesh(bytes, await materials(level));
      try {
        place(loaded, level);
        if (level.deviation !== undefined) recordDeviation(loaded, level.deviation);
        await restore?.(loaded, index);
        return loaded;
      } catch (error) {
        disposeTree(loaded);
        throw error;
      }
    };
    return {
      load,
      maxPixels: level.maxPixels,
      box: level.box.clone().applyMatrix4(level.matrix),
    };
  });
  return levels;
}

function materialsOf(object: Object3D | undefined): Material[] {
  const materials: Material[] = [];
  object?.traverse((node) => {
    if (isMesh(node)) for (const material of [node.material].flat()) materials.push(material);
  });
  return materials;
}

function place(object: Object3D, level: Metadata): void {
  object.name = level.name;
  level.matrix.decompose(object.position, object.quaternion, object.scale);
  object.matrix.copy(level.matrix);
  object.matrixAutoUpdate = level.matrixAutoUpdate;
  object.castShadow = level.castShadow;
  object.receiveShadow = level.receiveShadow;
}

function read(bytes: Uint8Array): { metadata: Metadata[]; coarsest: number; coarse: Uint8Array } {
  if (bytes.length < 8) fail("missing header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(4, true);
  if (view.getUint32(0, true) !== 0x32444f4c || length > bytes.length - 8) fail("invalid header");
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length)));
  if (!Array.isArray(parsed) || !parsed.length) fail("missing levels");
  let coarsest = -1;
  const metadata = parsed.map((value: unknown, index): Metadata => {
    const meta = object(value);
    const kind = meta.kind;
    if (kind !== "mesh" && kind !== "baked" && kind !== "impostor" && kind !== "empty" && kind !== "source") fail("unknown level kind");
    if (
      typeof meta.name !== "string" ||
      typeof meta.castShadow !== "boolean" ||
      typeof meta.receiveShadow !== "boolean" ||
      typeof meta.matrixAutoUpdate !== "boolean"
    )
      fail("invalid level settings");
    const size = finite(meta.length);
    if (!Number.isSafeInteger(size) || size < 0) fail("invalid payload length");
    const maxPixels = index === 0 && meta.maxPixels === null ? Infinity : finite(meta.maxPixels);
    if (maxPixels <= 0) fail("invalid maxPixels");
    const box = meta.box === null ? new Box3() : new Box3().setFromArray(numbers(meta.box, 6));
    if (box.isEmpty() && kind !== "empty") fail("drawable level has an empty box");
    if (!box.isEmpty()) coarsest = index;
    if ((kind === "empty" || kind === "source") !== (size === 0)) fail("invalid level payload length");
    const matrix = new Matrix4().fromArray(numbers(meta.matrix, 16));
    const deviation = meta.deviation === undefined ? undefined : finite(meta.deviation);
    if (deviation !== undefined && deviation < 0) fail("negative deviation");
    const draw = meta.draw === undefined ? undefined : drawOptions(meta.draw);
    const level: Metadata = {
      kind,
      materials: meta.materials === undefined ? undefined : references(meta.materials),
      name: meta.name,
      maxPixels,
      deviation,
      box,
      matrix,
      matrixAutoUpdate: meta.matrixAutoUpdate,
      draw,
      castShadow: meta.castShadow,
      receiveShadow: meta.receiveShadow,
      length: size,
    };
    return level;
  });
  if (coarsest < 0) fail("no drawable level");
  const size = coarsest > 0 ? metadata[coarsest]?.length : 0;
  if (size === undefined || bytes.length !== 8 + length + size) fail("invalid coarse payload length");
  return { metadata, coarsest, coarse: bytes.subarray(8 + length) };
}

function references(value: unknown): NonNullable<Metadata["materials"]> {
  if (!Array.isArray(value)) fail("invalid material references");
  return value.map((value) => {
    const entry = object(value);
    if (typeof entry.name !== "string") fail("invalid material name");
    return { name: entry.name, data: object(entry.data) };
  });
}

function drawOptions(value: unknown): ImpostorMeshOptions {
  const options = object(value);
  return {
    alphaTest: options.alphaTest === undefined ? undefined : finite(options.alphaTest),
    parallax: options.parallax === undefined ? undefined : finite(options.parallax),
    tolerance: options.tolerance === undefined ? undefined : finite(options.tolerance),
    mipBias: options.mipBias === undefined ? undefined : finite(options.mipBias),
  };
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("expected metadata object");
  return Object.fromEntries(Object.entries(value));
}
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("expected finite number");
  return value;
}
function numbers(value: unknown, count: number): number[] {
  if (!Array.isArray(value) || value.length !== count) fail(`expected ${count} numbers`);
  return value.map(finite);
}
function fail(reason: string): never {
  throw new Error(`LodLoader: invalid cache (${reason})`);
}

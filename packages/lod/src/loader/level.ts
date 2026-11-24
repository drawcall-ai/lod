import { Box3, Matrix4, type Material, type Object3D, type Renderer } from "three/webgpu";
import type { BlockFormat } from "../blocks/index.js";
import { decodeBakedMeshAsync, encodeBakedMeshAsync } from "../baked/codec.js";
import { boundingBox } from "../source/detail.js";
import { decodeImpostorAsync, encodeImpostorAsync } from "../impostor/codec.js";
import { ImpostorMesh, type ImpostorMeshOptions } from "../impostor/mesh/index.js";
import { isImpostorMesh, isMesh } from "../three.js";
import { decodeMeshAsync, encodeMeshAsync } from "../codec/mesh.js";
import type { LodLevelRequest } from "./request.js";

// A cached level: the source's shape, what places the level, then its payload.

/** A level the loader builds from the source and caches. */
export type Derived = Exclude<LodLevelRequest, { type: "empty" }>;
type Kind = Derived["type"];

/**
 * The source's full-detail bounds in its own space and its placement. Every drawable level declares these bounds,
 * so a ladder is described before its finer levels are built; each derived level must fit inside them.
 */
export interface Shape {
  box: Box3;
  matrix: Matrix4;
}

export function shapeOf(source: Object3D): Shape {
  if (source.matrixAutoUpdate) source.updateMatrix();
  return { box: boundingBox(source), matrix: source.matrix.clone() };
}

/** `shape` on its own, as its cache entry holds it. */
export const encodeShape = (shape: Shape): Uint8Array => new TextEncoder().encode(JSON.stringify(shapeFields(shape)));

export const readShape = (bytes: Uint8Array): Shape => parseShape(object(JSON.parse(new TextDecoder().decode(bytes))));

const shapeFields = ({ box, matrix }: Shape) => ({ box: [...box.min.toArray(), ...box.max.toArray()], placement: matrix.toArray() });

function parseShape(meta: Record<string, unknown>): Shape {
  const box = new Box3().setFromArray(numbers(meta.box, 6));
  if (box.isEmpty()) fail("empty source box");
  return { box, matrix: new Matrix4().fromArray(numbers(meta.placement, 16)) };
}

/** The bounds every drawable level declares, in the space of the Lod that holds it. */
export const placedBox = ({ box, matrix }: Shape): Box3 => box.clone().applyMatrix4(matrix);

interface Metadata {
  name: string;
  matrix: Matrix4;
  matrixAutoUpdate: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
}

export interface Entry {
  shape: Shape;
  level: Metadata;
  payload: Uint8Array;
}

const MAGIC = 0x33444f4c;

/**
 * `object`, a level of `kind` built from a source of `shape` drawn with `materials`, encoded with its maps as blocks of
 * `format`, which a level with maps needs, encoded on `renderer`'s device.
 */
export async function encodeLevel(
  object: Object3D,
  kind: Kind,
  shape: Shape,
  materials: readonly Material[],
  format: BlockFormat | null,
  renderer: () => Promise<Renderer>,
): Promise<Uint8Array> {
  if (object.matrixAutoUpdate) object.updateMatrix();
  const box = boundingBox(object).applyMatrix4(object.matrix);
  if (box.isEmpty()) throw new Error(`CachedLodLoader: the ${kind} level draws nothing`);
  const bounds = placedBox(shape);
  // Rounding in welds and bakes may move a vertex by a hair.
  if (
    !bounds
      .clone()
      .expandByScalar(bounds.getSize(box.min.clone()).length() * 1e-4)
      .containsBox(box)
  )
    throw new Error(`CachedLodLoader: the ${kind} level extends beyond the source's bounds; derived shapes, such as a low shell, must stay inside the source`);
  const payload = await encodePayload(object, kind, materials, format, renderer);
  const header = new TextEncoder().encode(
    JSON.stringify({
      ...shapeFields(shape),
      name: object.name,
      matrix: object.matrix.toArray(),
      matrixAutoUpdate: object.matrixAutoUpdate,
      castShadow: object.castShadow,
      receiveShadow: object.receiveShadow,
    }),
  );
  const bytes = new Uint8Array(8 + header.length + payload.length);
  const data = new DataView(bytes.buffer);
  data.setUint32(0, MAGIC, true);
  data.setUint32(4, header.length, true);
  bytes.set(header, 8);
  bytes.set(payload, 8 + header.length);
  return bytes;
}

async function encodePayload(
  object: Object3D,
  kind: Kind,
  materials: readonly Material[],
  format: BlockFormat | null,
  renderer: () => Promise<Renderer>,
): Promise<Uint8Array> {
  if (kind === "simplify") return encodeMeshAsync(object, materials);
  if (!format) throw new Error(`CachedLodLoader: a ${kind} level's maps need a block format`);
  if (kind === "baked") {
    if (!isMesh(object)) throw new Error("CachedLodLoader: baked level is not a mesh");
    return encodeBakedMeshAsync(object, await renderer(), format);
  }
  if (!isImpostorMesh(object)) throw new Error("CachedLodLoader: impostor level is not an ImpostorMesh");
  return encodeImpostorAsync(object.impostor, await renderer(), format);
}

/** Decode a level placed as it was built; `materials` are the source's, which a simplified level draws with. */
export async function decodeLevel(
  kind: Kind,
  { level, payload }: Entry,
  materials: () => Promise<Material[]>,
  draw: ImpostorMeshOptions | undefined,
): Promise<Object3D> {
  const object =
    kind === "simplify"
      ? await decodeMeshAsync(payload, await materials())
      : kind === "baked"
        ? await decodeBakedMeshAsync(payload)
        : new ImpostorMesh(await decodeImpostorAsync(payload), 1, draw);
  object.name = level.name;
  level.matrix.decompose(object.position, object.quaternion, object.scale);
  object.matrix.copy(level.matrix);
  object.matrixAutoUpdate = level.matrixAutoUpdate;
  object.castShadow = level.castShadow;
  object.receiveShadow = level.receiveShadow;
  return object;
}

export function readLevel(bytes: Uint8Array): Entry {
  if (bytes.length < 8) fail("missing header");
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = data.getUint32(4, true);
  if (data.getUint32(0, true) !== MAGIC || length > bytes.length - 8) fail("invalid header");
  const meta = object(JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))));
  if (
    typeof meta.name !== "string" ||
    typeof meta.castShadow !== "boolean" ||
    typeof meta.receiveShadow !== "boolean" ||
    typeof meta.matrixAutoUpdate !== "boolean"
  )
    fail("invalid level settings");
  return {
    shape: parseShape(meta),
    level: {
      name: meta.name,
      matrix: new Matrix4().fromArray(numbers(meta.matrix, 16)),
      matrixAutoUpdate: meta.matrixAutoUpdate,
      castShadow: meta.castShadow,
      receiveShadow: meta.receiveShadow,
    },
    payload: bytes.subarray(8 + length),
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
  throw new Error(`CachedLodLoader: invalid cache (${reason})`);
}

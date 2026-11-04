import { Box3, Matrix4, type Material, type Object3D } from "three/webgpu";
import { decodeBakedMeshAsync, encodeBakedMesh } from "../baked/codec.js";
import { boundingBox } from "../bounds.js";
import { decodeImpostorAsync, encodeImpostor } from "../impostor/codec.js";
import { ImpostorMesh, type ImpostorMeshOptions } from "../impostor/mesh/index.js";
import { measure, recordDeviation } from "../levels.js";
import { isImpostorMesh, isMesh } from "../three.js";
import { decodeMeshAsync, encodeMesh } from "../mesh/codec.js";
import type { LevelRequest } from "../loader.js";

// A cached level: the source's shape, what places the level and measures its default threshold, then its payload.

/** A level the loader builds from the source and caches. */
export type Derived = Exclude<LevelRequest, { type: "empty" }>;
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

/** The owner-space bounds every drawable level declares. */
export const placedBox = ({ box, matrix }: Shape): Box3 => box.clone().applyMatrix4(matrix);

interface Metadata {
  name: string;
  deviation?: number;
  texels?: number;
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

export async function encodeLevel(object: Object3D, kind: Kind, shape: Shape, materials: readonly Material[]): Promise<Uint8Array> {
  if (object.matrixAutoUpdate) object.updateMatrix();
  const box = boundingBox(object).applyMatrix4(object.matrix);
  if (box.isEmpty()) throw new Error(`LodLoader: the ${kind} level draws nothing`);
  const bounds = placedBox(shape);
  // Rounding in welds and bakes may move a vertex by a hair.
  if (
    !bounds
      .clone()
      .expandByScalar(bounds.getSize(box.min.clone()).length() * 1e-4)
      .containsBox(box)
  )
    throw new Error(`LodLoader: the ${kind} level extends beyond the source's bounds; keep derived shapes, such as a low shell, inside the source`);
  const payload = await encodePayload(object, kind, materials);
  const header = new TextEncoder().encode(
    JSON.stringify({
      box: [...shape.box.min.toArray(), ...shape.box.max.toArray()],
      placement: shape.matrix.toArray(),
      name: object.name,
      ...measure(object),
      matrix: object.matrix.toArray(),
      matrixAutoUpdate: object.matrixAutoUpdate,
      castShadow: object.castShadow,
      receiveShadow: object.receiveShadow,
    }),
  );
  const bytes = new Uint8Array(8 + header.length + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, header.length, true);
  bytes.set(header, 8);
  bytes.set(payload, 8 + header.length);
  return bytes;
}

async function encodePayload(object: Object3D, kind: Kind, materials: readonly Material[]): Promise<Uint8Array> {
  switch (kind) {
    case "simplify":
      return encodeMesh(object, materials);
    case "baked":
      if (!isMesh(object)) throw new Error("LodLoader: baked level is not a mesh");
      return encodeBakedMesh(object);
    case "impostor":
      if (!isImpostorMesh(object)) throw new Error("LodLoader: impostor level is not an ImpostorMesh");
      return encodeImpostor(object.impostor);
  }
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
  if (level.deviation !== undefined) recordDeviation(object, level.deviation);
  return object;
}

export function readLevel(bytes: Uint8Array): Entry {
  if (bytes.length < 8) fail("missing header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(4, true);
  if (view.getUint32(0, true) !== MAGIC || length > bytes.length - 8) fail("invalid header");
  const meta = object(JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))));
  if (
    typeof meta.name !== "string" ||
    typeof meta.castShadow !== "boolean" ||
    typeof meta.receiveShadow !== "boolean" ||
    typeof meta.matrixAutoUpdate !== "boolean"
  )
    fail("invalid level settings");
  const box = new Box3().setFromArray(numbers(meta.box, 6));
  if (box.isEmpty()) fail("empty source box");
  const deviation = meta.deviation === undefined ? undefined : finite(meta.deviation);
  if (deviation !== undefined && deviation < 0) fail("negative deviation");
  const texels = meta.texels === undefined ? undefined : finite(meta.texels);
  if (texels !== undefined && texels <= 0) fail("invalid texels");
  return {
    shape: { box, matrix: new Matrix4().fromArray(numbers(meta.placement, 16)) },
    level: {
      name: meta.name,
      deviation,
      texels,
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
  throw new Error(`LodLoader: invalid cache (${reason})`);
}

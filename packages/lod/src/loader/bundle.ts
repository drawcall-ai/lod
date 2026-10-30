import { Box3, Group, Matrix4, type Material, type Object3D } from "three/webgpu";
import { decodeBakedMeshAsync, encodeBakedMesh } from "../baked/codec.js";
import { boundingBox, measureLevels } from "../bounds.js";
import { loadOnce } from "../deferred.js";
import { disposeRejected } from "../dispose.js";
import { decodeImpostorAsync, encodeImpostor } from "../impostor/codec.js";
import { ImpostorMesh, type ImpostorMeshOptions } from "../impostor/mesh/index.js";
import { measure, recordDeviation, resolveThresholds, type LodLevel } from "../levels.js";
import { isImpostorMesh, isMesh } from "../three.js";
import { decodeMeshAsync, encodeMesh } from "../mesh/codec.js";
import type { LevelRequest } from "../loader.js";

export type Kind = "source" | LevelRequest["type"];

/** The coarsest drawable level, whose payload the index inlines unless it is the source, which loads from its URL. */
function coarsestOf(kinds: readonly Kind[]): number {
  return kinds.reduce((last, kind, index) => (kind === "empty" ? last : index), -1);
}

/** The ladder indices whose payload is saved as its own entry: every derived drawable level except the inlined coarsest. */
export function separateLevels(kinds: readonly Kind[]): number[] {
  const coarsest = coarsestOf(kinds);
  return kinds.flatMap((kind, index) => (kind === "source" || kind === "empty" || index === coarsest ? [] : [index]));
}

interface Metadata {
  kind: Kind;
  name: string;
  deviation?: number;
  texels?: number;
  box: Box3;
  matrix: Matrix4;
  matrixAutoUpdate: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
  length: number;
}

/**
 * Inline coarse derived payloads; a source-only request leaves its source deferred. The index
 * keeps what thresholds are measured from, not thresholds or impostor draw options, so changing
 * either reuses the cache. `levels` maps each deferred level index to its payload.
 */
export async function encode(objects: readonly Object3D[], kinds: readonly Kind[]): Promise<{ index: Uint8Array; levels: Map<number, Uint8Array> }> {
  const payloads: Uint8Array[] = [];
  const metadata = [];
  const materials = materialsOf(objects[0]);
  if (kinds.length !== objects.length) throw new Error("LodLoader: level kinds do not match levels");
  for (const [level, object] of objects.entries()) {
    const kind = kinds[level];
    if (!kind) throw new Error("LodLoader: missing level kind");
    const box = boundingBox(object);
    if (box.isEmpty() && kind !== "empty") throw new Error(`LodLoader: ${kind} level ${level} has an empty box`);
    const bytes = await payload(object, kind, materials);
    if (object.matrixAutoUpdate) object.updateMatrix();
    metadata.push({
      kind,
      name: object.name,
      ...measure(object),
      box: box.isEmpty() ? null : [...box.min.toArray(), ...box.max.toArray()],
      matrix: object.matrix.toArray(),
      matrixAutoUpdate: object.matrixAutoUpdate,
      castShadow: object.castShadow,
      receiveShadow: object.receiveShadow,
      length: bytes.byteLength,
    });
    payloads.push(bytes);
  }
  const coarsest = coarsestOf(kinds);
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
  const levels = new Map(
    separateLevels(kinds).map((level) => {
      const bytes = payloads[level];
      if (!bytes) throw new Error(`LodLoader: missing payload ${level}`);
      return [level, bytes] as const;
    }),
  );
  return { index, levels };
}

async function payload(object: Object3D, kind: Kind, materials: readonly Material[]): Promise<Uint8Array> {
  switch (kind) {
    case "source":
    case "empty":
      return new Uint8Array();
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

/** The inverse of `payload`; `read` has checked that a source or empty level has no bytes. */
async function decodePayload(
  kind: Kind,
  bytes: () => Promise<Uint8Array>,
  loadSource: () => Promise<Object3D>,
  materials: () => Promise<Material[]>,
  draw: ImpostorMeshOptions | undefined,
): Promise<Object3D> {
  switch (kind) {
    case "source":
      return loadSource();
    case "empty":
      return new Group();
    case "simplify":
      return decodeMeshAsync(await bytes(), await materials());
    case "baked":
      return decodeBakedMeshAsync(await bytes());
    case "impostor":
      return new ImpostorMesh(await decodeImpostorAsync(await bytes()), 1, draw);
  }
}

/** What a request sets per level at decode, without changing cached content. */
interface Requested {
  maxPixels?: number;
  draw?: ImpostorMeshOptions;
}

/** Index metadata exposes every drawable level without decoding its payload. `requested` holds level i's request at i. */
export function decode(
  bytes: Uint8Array,
  requested: readonly Requested[],
  loadSource: () => Promise<Object3D>,
  loadLevel: (index: number) => Promise<Uint8Array>,
  onLevel?: (object: Object3D, index: number) => void | Promise<void>,
  release = disposeRejected,
): LodLevel[] {
  const { metadata, coarsest, coarse } = read(bytes);
  if (requested.length !== metadata.length) fail("level count");
  const diameter = measureLevels(metadata, "LodLoader").own.radius * 2;
  const thresholds = resolveThresholds(
    metadata.map(({ deviation, texels }, index) => ({ maxPixels: requested[index]?.maxPixels, measured: { deviation, texels } })),
    diameter,
  );
  const materials = async (): Promise<Material[]> => {
    const source = levels[0];
    if (!source) fail("missing source materials");
    return materialsOf(source.object ?? (await loadOnce(source.load).promise));
  };
  const levels: LodLevel[] = metadata.map((level, index) => {
    const load = async () => {
      const levelBytes = async () => {
        const payload = index === coarsest && coarsest > 0 ? coarse : await loadLevel(index);
        if (payload.length !== level.length) fail(`level ${index} payload length`);
        return payload;
      };
      const loaded = await decodePayload(level.kind, levelBytes, loadSource, materials, requested[index]?.draw);
      try {
        place(loaded, level);
        if (level.deviation !== undefined) recordDeviation(loaded, level.deviation);
        await onLevel?.(loaded, index);
        return loaded;
      } catch (error) {
        release(loaded);
        throw error;
      }
    };
    return {
      load,
      maxPixels: thresholds[index] ?? fail("missing threshold"),
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
  const metadata = parsed.map((value: unknown): Metadata => {
    const meta = object(value);
    const kind = meta.kind;
    if (kind !== "simplify" && kind !== "baked" && kind !== "impostor" && kind !== "empty" && kind !== "source") fail("unknown level kind");
    if (
      typeof meta.name !== "string" ||
      typeof meta.castShadow !== "boolean" ||
      typeof meta.receiveShadow !== "boolean" ||
      typeof meta.matrixAutoUpdate !== "boolean"
    )
      fail("invalid level settings");
    const size = finite(meta.length);
    if (!Number.isSafeInteger(size) || size < 0) fail("invalid payload length");
    const box = meta.box === null ? new Box3() : new Box3().setFromArray(numbers(meta.box, 6));
    if (box.isEmpty() && kind !== "empty") fail("drawable level has an empty box");
    if ((kind === "empty" || kind === "source") !== (size === 0)) fail("invalid level payload length");
    const matrix = new Matrix4().fromArray(numbers(meta.matrix, 16));
    const deviation = meta.deviation === undefined ? undefined : finite(meta.deviation);
    if (deviation !== undefined && deviation < 0) fail("negative deviation");
    const texels = meta.texels === undefined ? undefined : finite(meta.texels);
    if (texels !== undefined && texels <= 0) fail("invalid texels");
    const level: Metadata = {
      kind,
      name: meta.name,
      deviation,
      texels,
      box,
      matrix,
      matrixAutoUpdate: meta.matrixAutoUpdate,
      castShadow: meta.castShadow,
      receiveShadow: meta.receiveShadow,
      length: size,
    };
    return level;
  });
  const coarsest = coarsestOf(metadata.map((level) => level.kind));
  if (coarsest < 0) fail("no drawable level");
  const size = coarsest > 0 ? metadata[coarsest]?.length : 0;
  if (size === undefined || bytes.length !== 8 + length + size) fail("invalid coarse payload length");
  return { metadata, coarsest, coarse: bytes.subarray(8 + length) };
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

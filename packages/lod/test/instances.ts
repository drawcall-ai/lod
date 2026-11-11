import { InstancedBufferAttribute, Matrix4, type Camera, type Color, type Object3D } from "three/webgpu";
import { InstancedLod, type InstancedLodOptions } from "../src/instanced/index.js";
import { isCpuChunk, type InstancedLodCpuChunk } from "../src/instanced/chunk.js";
import { fadeSourceOf, type InstanceSlots } from "../src/levels/fade.js";
import type { LodLevel } from "../src/levels/index.js";
import { gpu } from "./renderer.js";
import type { LodGpu } from "../src/gpu.js";

/** `matrices` as a chunk's CPU instanceMatrix. */
export function instanceMatrix(matrices: readonly Matrix4[]): InstancedBufferAttribute {
  const array = new Float32Array(matrices.length * 16);
  matrices.forEach((matrix, i) => matrix.toArray(array, i * 16));
  return new InstancedBufferAttribute(array, 16);
}

/** `colors` as a chunk's CPU instanceColor. */
export function instanceColor(colors: readonly Color[]): InstancedBufferAttribute {
  const array = new Float32Array(colors.length * 3);
  colors.forEach((color, i) => color.toArray(array, i * 3));
  return new InstancedBufferAttribute(array, 3);
}

/**
 * An InstancedLod of `levels` holding one CPU chunk: of `instances` identity matrices, or of the matrices given,
 * coloured by `colors` if given, drawn with `on` (the tests' LodGpu by default).
 */
export function oneChunk(
  levels: readonly LodLevel[],
  instances: number | readonly Matrix4[],
  { colors, on = gpu, ...options }: InstancedLodOptions & { colors?: readonly Color[]; on?: LodGpu } = {},
): InstancedLod {
  const lod = new InstancedLod(levels, on, options);
  const matrices = typeof instances === "number" ? Array.from({ length: instances }, () => new Matrix4()) : instances;
  lod.addChunk({ instanceMatrix: instanceMatrix(matrices), instanceColor: colors && instanceColor(colors) });
  return lod;
}

/** `lod`'s only chunk, from the CPU. */
export function chunkOf(lod: InstancedLod): InstancedLodCpuChunk {
  const [chunk, ...others] = lod.chunks;
  if (!chunk || others.length > 0 || !isCpuChunk(chunk)) throw new Error("the InstancedLod holds no CPU chunk or several chunks");
  return chunk;
}

/** What a level mesh of an InstancedLod draws for `camera`: its lists, and where its camera's indirect draws lie. */
export function drawnSlots(mesh: Object3D, camera: Camera): InstanceSlots {
  const source = fadeSourceOf(mesh);
  if (source?.kind !== "instances" || !source.slots) throw new Error("not a level mesh");
  return source.slots(camera);
}

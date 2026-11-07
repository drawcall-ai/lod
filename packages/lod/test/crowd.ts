import { Matrix4 } from "three/webgpu";
import { InstancedLod } from "../src/instanced/index.js";
import type { LodLevel } from "../src/levels.js";
import type { LodOptions } from "../src/owner.js";

/** `count` identity matrices, as a chunk takes them. */
export function identities(count: number): Float32Array {
  const matrices = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) new Matrix4().toArray(matrices, i * 16);
  return matrices;
}

/** An InstancedLod of `levels` holding one chunk of `count` instances at its origin: instances 0 to `count` - 1. */
export function oneChunk(levels: readonly LodLevel[], count: number, options?: LodOptions): InstancedLod {
  const lod = new InstancedLod(levels, options);
  lod.addChunk({ matrices: identities(count) });
  return lod;
}

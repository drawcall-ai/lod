import { Matrix4, type Camera, type Color, type Object3D } from "three/webgpu";
import { Lod, type LodOptions } from "../src/lod.js";
import { fadeSourceOf, type InstanceSlots } from "../src/levels/fade.js";
import type { LodLevel } from "../src/levels/index.js";

/**
 * A Lod of `levels` with `instances` identity matrices, or with the matrices given, coloured by `colors` if given: its
 * CPU attributes edited as an app edits an InstancedMesh's.
 */
export function lodOf(levels: readonly LodLevel[], instances: number | readonly Matrix4[], { colors, ...options }: LodOptions & { colors?: readonly Color[] } = {}): Lod {
  const matrices = typeof instances === "number" ? Array.from({ length: instances }, () => new Matrix4()) : instances;
  const lod = new Lod(levels, matrices.length, options);
  matrices.forEach((matrix, i) => lod.setMatrixAt(i, matrix));
  lod.instanceMatrix.needsUpdate = true;
  colors?.forEach((color, i) => lod.setColorAt(i, color));
  return lod;
}

/** What a level mesh of a Lod draws for `camera`: its lists, and where its camera's indirect draws lie. */
export function drawnSlots(mesh: Object3D, camera: Camera): InstanceSlots {
  const source = fadeSourceOf(mesh);
  if (!source?.slots) throw new Error("not a level mesh");
  const slots = source.slots(camera);
  if (!slots) throw new Error("the level mesh has not sorted yet");
  return slots;
}

import { Color, Matrix4, PerspectiveCamera, Scene, type BufferAttribute, type Camera, type Object3D } from "three/webgpu";
import type { InstancedLod } from "../../src/instanced/index.js";
import { DRAW_BYTES } from "../../src/instanced/rows.js";
import { fadeSourceOf } from "../../src/levels/fade.js";
import { isImpostorMesh, isMesh } from "../../src/three.js";
import { pool, render, renderer } from "../renderer.js";
import { box } from "../box.js";
import { chunkOf, drawnSlots, oneChunk } from "../instances.js";

// Boxes on the -z axis drawn by a camera at the origin, and what the GPU sorted them into, which the InstancedLod tests read.

const DIAMETER = 2 * Math.sqrt(3);
const tan = Math.tan(Math.PI / 6);
/** The target the tests render into: the height levels are measured on. */
export const SIZE = 64;
/** Distance at which the box is `pixels` tall on the target. */
export const distanceAt = (pixels: number) => (DIAMETER * SIZE) / (2 * tan * pixels);
/** Instances on the -z axis, at `distances` from the origin. */
export const onAxis = (distances: readonly number[]) => distances.map((distance) => new Matrix4().makeTranslation(0, 0, -distance));

/**
 * An InstancedLod of three box levels with one chunk, instance i at the distance on the -z axis where it is
 * `heights[i]` px tall, and a camera at the origin looking down -z with a 60° fov: the InstancedLod, the camera and the
 * chunk.
 */
export function boxesAtHeights(heights: number[]) {
  const lod = oneChunk(
    [{ object: box("source") }, { object: box("simplified") }, { object: box("impostor") }],
    onAxis(heights.map((pixels) => distanceAt(pixels))),
  );
  lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 40, 10][i] ?? level.maxPixels));
  const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
  return { lod, camera, chunk: chunkOf(lod) };
}

/** Render `lod` from `camera`, so the GPU sorts its instances: twice, the first frame tells it the target's height. */
export async function renderSorted(lod: InstancedLod, camera: Camera): Promise<void> {
  const scene = new Scene().add(lod.parent ?? lod);
  await render(scene, camera, SIZE);
  await render(scene, camera, SIZE);
}

export const readBack = async (attribute: BufferAttribute) => renderer.getArrayBufferAsync(attribute);
/** Its level meshes, in the order of their draws. */
export const drawnMeshes = (lod: InstancedLod) => lod.children.filter(isMesh).filter((mesh) => fadeSourceOf(mesh) !== undefined);

/** The instances `mesh` draws: its matrices and colours. */
export function instancesOf(mesh: Object3D) {
  if (isMesh(mesh) && isImpostorMesh(mesh)) return { matrices: mesh.instanceMatrix, colors: mesh.instanceColor };
  const source = fadeSourceOf(mesh);
  if (source?.kind !== "instances" || !source.level) throw new Error("not a level mesh");
  return source.level.instances;
}

/**
 * Per level mesh, what the GPU put in its lists for `camera`: each instance's distance, colour and signed fade, in list
 * order. The camera's due sorts run first, as its next draw would run them.
 */
export async function sortedLists(lod: InstancedLod, camera: Camera) {
  pool.on(renderer).sorter.run(renderer, camera);
  return Promise.all(
    drawnMeshes(lod).map(async (mesh, index) => {
      const { indices, fades, args } = drawnSlots(mesh, camera);
      // One draw per mesh, in the order of the meshes.
      const offset = args.offset + index * DRAW_BYTES;
      const words = new Uint32Array(await readBack(args.attribute));
      const count = words[offset / 4 + 1] ?? 0;
      // The level's first slot: the draw's first instance (after its base vertex, indexed).
      const first = words[offset / 4 + (mesh.geometry.index ? 4 : 3)] ?? 0;
      const listed = new Uint32Array(await readBack(indices));
      const { matrices, colors } = instancesOf(mesh);
      const floats = new Float32Array(await readBack(matrices));
      const signed = new Float32Array(await readBack(fades));
      const tints = colors && new Float32Array(await readBack(colors));
      return Array.from({ length: count }, (_, k) => {
        const i = listed[first + k] ?? 0;
        return {
          distance: Math.round(-(floats[i * 16 + 14] ?? 0)),
          fade: signed[first + k] ?? 0,
          color: tints ? new Color().fromArray(tints, i * 4).getHex() : null,
        };
      });
    }),
  );
}

/** Per level, the distances of the instances it draws for `camera`, nearest first. */
export const distances = async (lod: InstancedLod, camera: Camera) =>
  (await sortedLists(lod, camera)).map((level) => level.map((slot) => slot.distance).sort((a, b) => a - b));

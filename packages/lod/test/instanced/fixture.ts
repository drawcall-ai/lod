import { Color, Matrix4, PerspectiveCamera, Scene, type BufferAttribute, type Camera, type Object3D } from "three/webgpu";
import type { Lod } from "../../src/lod.js";
import { DRAW_BYTES } from "../../src/instanced/rows.js";
import { fadeSourceOf, white } from "../../src/levels/fade.js";
import { isImpostorMesh, isMesh } from "../../src/three.js";
import { render, renderer } from "../renderer.js";
import { box } from "../box.js";
import { drawnSlots, lodOf } from "../instances.js";

// Boxes on the -z axis drawn by a camera at the origin, and what the GPU sorted them into, which the Lod tests read.

const DIAMETER = 2 * Math.sqrt(3);
const tan = Math.tan(Math.PI / 6);
/** The target the tests render into: the height levels are measured on. */
export const SIZE = 64;
/** Distance at which the box is `pixels` tall on the target. */
export const distanceAt = (pixels: number) => (DIAMETER * SIZE) / (2 * tan * pixels);
/** Instances on the -z axis, at `distances` from the origin. */
export const onAxis = (distances: readonly number[]) => distances.map((distance) => new Matrix4().makeTranslation(0, 0, -distance));

/**
 * A Lod of three box levels, instance i at the distance on the -z axis where it is `heights[i]` px tall, and a camera
 * at the origin looking down -z with a 60° fov.
 */
export function boxesAtHeights(heights: number[]) {
  const lod = lodOf(
    [{ object: box("source") }, { object: box("simplified") }, { object: box("impostor") }],
    onAxis(heights.map((pixels) => distanceAt(pixels))),
  );
  lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 40, 10][i] ?? level.maxPixels));
  const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
  return { lod, camera };
}

/** Render `lod` from `camera`, so the GPU sorts its instances: twice, as the first frame binds it to the renderer. */
export async function renderSorted(lod: Lod, camera: Camera): Promise<void> {
  const scene = new Scene().add(lod.parent ?? lod);
  await render(scene, camera, SIZE);
  await render(scene, camera, SIZE);
}

export const readBack = async (attribute: BufferAttribute) => renderer.getArrayBufferAsync(attribute);
/** Its level meshes, in the order of their draws. */
export const drawnMeshes = (lod: Lod) => lod.children.filter(isMesh).filter((mesh) => fadeSourceOf(mesh) !== undefined);

/** The instances `mesh` draws: its matrices and colours. */
export function instancesOf(mesh: Object3D) {
  if (isMesh(mesh) && isImpostorMesh(mesh)) return { matrices: mesh.instanceMatrix, colors: mesh.instanceColor };
  const source = fadeSourceOf(mesh);
  if (!source?.level) throw new Error("not a level mesh");
  return source.level.instances;
}

/**
 * Per level mesh, what the GPU put in its lists for `camera`: each instance's distance, colour and signed fade, in list
 * order, as the camera's last draw sorted them.
 */
export async function sortedLists(lod: Lod, camera: Camera) {
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
      // A draw without colours reads white's one.
      const tints = colors && colors !== white ? new Float32Array(await readBack(colors)) : null;
      return Array.from({ length: count }, (_, k) => {
        const i = listed[first + k] ?? 0;
        return {
          distance: Math.round(-(floats[i * 16 + 14] ?? 0)),
          fade: signed[first + k] ?? 0,
          color: tints ? new Color().fromArray(tints, i * 4).getHex() : 0xffffff,
        };
      });
    }),
  );
}

/** Per level, the distances of the instances it draws for `camera`, nearest first. */
export const distances = async (lod: Lod, camera: Camera) =>
  (await sortedLists(lod, camera)).map((level) => level.map((slot) => slot.distance).sort((a, b) => a - b));

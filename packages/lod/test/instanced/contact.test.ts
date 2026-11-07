import { BoxGeometry, Matrix4, Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, PlaneGeometry, Scene, type Camera } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { ContactMesh } from "../../src/instanced/contact.js";
import { InstancedLod } from "../../src/instanced/index.js";
import { CONTACT_FADE } from "../../src/instanced/kernel.js";
import { keptFraction } from "../../src/instanced/range.js";
import { GPU_TIMEOUT, render, renderer } from "../gpu.js";
import { must } from "../must.js";

const SIZE = 64;
const box = () => new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
const words = async (attribute: Parameters<typeof renderer.getArrayBufferAsync>[0]) => new Uint32Array(await renderer.getArrayBufferAsync(attribute));

/** Instances on the z axis at `spots` (negative: behind a camera at the origin looking down -z), with `keeps`. */
function crowd(spots: number[], keeps: number[]): InstancedLod {
  const lod = new InstancedLod([{ object: box() }]);
  lod.addChunk({ matrices: spots.flatMap((spot) => new Matrix4().makeTranslation(0, 0, -spot).elements), keeps });
  return lod;
}

/** The instances in the draw `offset` bytes into `camera`'s draws of `lod`, with what the slots hold for them. */
async function drawn(lod: InstancedLod, camera: Camera, offset: number): Promise<Array<{ index: number; fade: number }>> {
  const contacts = must(lod.children.find((child) => child instanceof ContactMesh));
  const { indices, fades, args } = contacts.selection.view(camera);
  const draw = (args.offset + offset) / 4;
  const all = await words(args.attribute);
  const count = all[draw + 1] ?? 0;
  // Every draw here is indexed: its first instance follows its base vertex.
  const first = all[draw + 4] ?? 0;
  const slots = await words(indices);
  const signed = new Float32Array(await renderer.getArrayBufferAsync(fades));
  return Array.from({ length: count }, (_, k) => ({ index: slots[first + k] ?? 0, fade: signed[first + k] ?? 0 })).sort((a, b) => a.index - b.index);
}

describe("contact", { timeout: GPU_TIMEOUT }, () => {
  it("draws a contact for exactly the instances a view draws within the contact distance, fading out before it", async () => {
    const spots = [5, 15, 25, 35, 45, 55, -5, -15];
    const keeps = [0.1, 0.9, 0.2, 0.5, 0.05, 0.1, 0.1, 0.1];
    const lod = crowd(spots, keeps);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    const range = { camera, radius: 60, ramp: 40 };
    lod.range = range;
    lod.contact = { radius: 1.5, strength: 0.8, distance: 50 };
    const scene = new Scene().add(lod);
    /** Selects, then checks the levels draw what is in the frustum (ahead of the camera) and kept, and only those within 50 have contacts. */
    const check = async () => {
      for (let i = 0; i < 2; i++) await render(scene, camera, SIZE);
      const contacts = must(lod.children.find((child) => child instanceof ContactMesh));
      const levels = await drawn(lod, camera, 0);
      const ringed = await drawn(lod, camera, contacts.selection.contactOffset);
      const shown = spots.flatMap((spot, i) => (spot > 0 && (keeps[i] ?? 1) < keptFraction(spot, range) ? [i] : []));
      expect(levels.map((slot) => slot.index)).toEqual(shown);
      expect(ringed.map((slot) => slot.index)).toEqual(shown.filter((i) => (spots[i] ?? 0) < 50));
      const fade = (spot: number) => Math.min((50 - spot) / (50 * CONTACT_FADE), 1);
      for (const { index, fade: strength } of ringed) expect(strength).toBeCloseTo(fade(spots[index] ?? 0), 5);
    };
    try {
      await check();
      lod.contact = null;
      for (let i = 0; i < 2; i++) await render(scene, camera, SIZE);
      expect(lod.children.some((child) => child instanceof ContactMesh)).toBe(false);
      // On again, while a chunk grows the crowd's capacity.
      lod.contact = { radius: 1.5, strength: 0.8, distance: 50 };
      lod.addChunk({ matrices: [10, 30].flatMap((spot) => new Matrix4().makeTranslation(0, 0, -spot).elements), keeps: [0.1, 0.1] });
      spots.push(10, 30);
      keeps.push(0.1, 0.1);
      await check();
    } finally {
      lod.dispose();
    }
  });

  it.each([0, 0.25])("darkens ground of slope %s under an instance, most at its origin, on every side, not beyond the radius", async (slope) => {
    const lod = new InstancedLod([{ object: new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshBasicMaterial()) }]);
    lod.addChunk({ matrices: new Matrix4().elements });
    lod.contact = { radius: 5, strength: 1, distance: 100 };
    // Rising along +x through the instance's origin, which stands upright.
    const ground = new Mesh(new PlaneGeometry(40, 40).rotateX(-Math.PI / 2).rotateZ(Math.atan(slope)), new MeshBasicMaterial());
    // From above, 20 units across the target: 3.2 px per unit.
    const camera = new OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
    camera.position.set(0, 20, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const scene = new Scene().add(ground, lod);
    /** The red byte of the pixel `units` from the centre along x. */
    const at = (pixels: Uint8Array, units: number) => pixels[(32 * SIZE + Math.round(32 + units * 3.2)) * 4] ?? 0;
    try {
      await render(scene, camera, SIZE);
      const pixels = await render(scene, camera, SIZE);
      for (const side of [1, -1]) {
        expect(at(pixels, 1.5 * side)).toBeLessThan(at(pixels, 3 * side));
        expect(at(pixels, 3 * side)).toBeLessThan(250);
        expect(at(pixels, 7 * side)).toBeGreaterThan(250);
      }
    } finally {
      lod.dispose();
      ground.geometry.dispose();
      ground.material.dispose();
    }
  });
});

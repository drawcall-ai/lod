import { DirectionalLight, Matrix4, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Scene, Vector3 } from "three/webgpu";
import { d } from "typegpu";
import { describe, expect, it } from "vitest";
import { cullScale } from "../../src/instanced/measure.js";
import { GPU_TIMEOUT, render, renderer } from "../renderer.js";
import { drawnSlots, lodOf } from "../instances.js";
import { must } from "../must.js";
import { box } from "../box.js";
import { SIZE, distanceAt, distances, instancesOf, drawnMeshes, readBack, onAxis, renderSorted } from "./fixture.js";

/** Whether cullDistance draws an instance at `origin`, `distance` from its camera: the CPU's answer. */
const culled = (origin: Vector3, distance: number, near: number, far: number) =>
  cullScale(d.vec3f(origin.x, origin.y, origin.z), Math.fround(distance), near, far, 0) === 0;

describe("cullDistance", { timeout: GPU_TIMEOUT }, () => {
  const spots = Array.from({ length: 20 }, (_, i) => 10 * (i + 1));

  it("thins the instances by their origins' hashes between near and far: nested subsets as its camera recedes", async () => {
    const lod = lodOf([{ object: box("source") }], onAxis(spots));
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    lod.cullDistance = { camera, near: 40, far: 160 };
    try {
      let previous: number[] | null = null;
      for (const eye of [0, 15, 30]) {
        camera.position.z = eye;
        camera.updateMatrixWorld();
        await renderSorted(lod, camera);
        const [drawn = []] = await distances(lod, camera);
        const expected = spots.filter((spot) => !culled(new Vector3(0, 0, -spot), spot + eye, 40, 160));
        expect(drawn).toEqual(expected);
        expect(drawn.length).toBeGreaterThan(3);
        expect(drawn.length).toBeLessThan(spots.length);
        if (previous) expect(previous).toEqual(expect.arrayContaining(drawn));
        previous = drawn;
        expect(spots.map((_, i) => lod.getLevelAt(i, camera) !== null)).toEqual(spots.map((spot) => expected.includes(spot)));
      }
      lod.cullDistance = null;
      await renderSorted(lod, camera);
      expect((await distances(lod, camera))[0]).toHaveLength(spots.length);
    } finally {
      lod.dispose();
    }
  });

  it("measures distances from its camera in shadow maps too, so an instance and its shadow go together", async () => {
    const source = box("source");
    source.castShadow = true;
    // In the camera at 10 and 30, behind it at the same distances, and two beyond far.
    const lod = lodOf([{ object: source }], onAxis([10, 30, 50, -10, -30, -50]));
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    lod.cullDistance = { camera, near: 40, far: 45 };
    // The sun is about 50 from every instance: measured from it, none would draw.
    const sun = new DirectionalLight();
    sun.position.set(0, 50, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(256, 256);
    Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 100 });
    sun.shadow.camera.updateProjectionMatrix();
    const ground = new Mesh(new PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new MeshStandardMaterial());
    ground.position.y = -2;
    ground.receiveShadow = true;
    const scene = new Scene().add(lod, ground, sun, sun.target);
    renderer.shadowMap.enabled = true;
    try {
      for (let i = 0; i < 2; i++) await render(scene, camera, SIZE);
      expect(await distances(lod, camera)).toEqual([[10, 30]]);
      expect(await distances(lod, sun.shadow.camera)).toEqual([[-30, -10, 10, 30]]);
    } finally {
      renderer.shadowMap.enabled = false;
      lod.dispose();
      sun.dispose();
      ground.geometry.dispose();
      ground.material.dispose();
    }
  });

  it("scales survivors by 1 / sqrt of the share drawn when asked, choosing their level at that size", async () => {
    // 30 px tall unscaled: the simplified level; where a quarter is drawn, twice that: the source.
    const distance = distanceAt(30);
    // An origin whose hash survives a quarter.
    let x = 0;
    const from = (x: number) => Math.hypot(x, distance);
    while (culled(new Vector3(x, 0, -distance), from(x), from(x) - 3, from(x) + 1)) x += 0.01;
    const origin = new Matrix4().makeTranslation(x, 0, -distance);
    const lod = lodOf([{ object: box("source") }, { object: box("simplified") }], [origin]);
    must(lod.levels[1]).maxPixels = 40;
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    const near = from(x) - 3;
    lod.cullDistance = { camera, near, far: near + 4 };
    try {
      await renderSorted(lod, camera);
      expect(lod.getLevelAt(0, camera)).toBe(1);
      expect((await distances(lod, camera)).map((level) => level.length)).toEqual([0, 1]);
      lod.cullDistance = { ...lod.cullDistance, scaleSurvivors: true };
      await renderSorted(lod, camera);
      expect(lod.getLevelAt(0, camera)).toBe(0);
      expect((await distances(lod, camera)).map((level) => level.length)).toEqual([1, 0]);
      const source = must(drawnMeshes(lod)[0]);
      const { matrices } = instancesOf(source);
      // The instance the source level's list holds first: the draw's first instance.
      const { indices, args } = drawnSlots(source, camera);
      const first = new Uint32Array(await readBack(args.attribute))[args.offset / 4 + 4] ?? 0;
      const index = new Uint32Array(await readBack(indices))[first] ?? 0;
      const scaled = new Matrix4().fromArray(new Float32Array(await readBack(matrices)), index * 16);
      expect(scaled.getMaxScaleOnAxis()).toBeCloseTo(2, 3);
      expect(scaled.elements[14]).toBeCloseTo(-distance, 3);
    } finally {
      lod.dispose();
    }
  });
});

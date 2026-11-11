import {
  AmbientLight,
  Box3,
  BoxGeometry,
  DirectionalLight,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  PerspectiveCamera,
  Scene,
  Vector3,
  RGBAFormat,
  WebGPURenderer,
  type BufferAttribute,
  type Object3D,
} from "three/webgpu";
import { uniform } from "three/tsl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARRIVAL_MS } from "../../src/levels/manager.js";
import { InstancedLod } from "../../src/instanced/index.js";
import { Lod } from "../../src/lod.js";
import { Wind } from "../../src/wind/index.js";
import { ImpostorMesh } from "../../src/impostor/mesh/index.js";
import type { Impostor } from "../../src/impostor/impostor.js";
import { GPU_TIMEOUT, eventually, render, renderer, nextLevel, pool, updateInRender } from "../renderer.js";
import { chunkOf, drawnSlots, instanceColor, instanceMatrix, oneChunk } from "../instances.js";
import { must } from "../must.js";
import { box } from "../box.js";
import { SIZE, distanceAt, distances, sortedLists, drawnMeshes, onAxis, boxesAtHeights, renderSorted } from "./fixture.js";

/** A made-up impostor, which the CPU can place without its textures. */
const impostor = (): Impostor => ({
  version: 4,
  layout: "full",
  frames: 4,
  size: 16,
  box: [-1, 0, -1, 1, 2, 1],
  halfSize: 1.5,
  maps: ["base", "normalDepth", "orm"],
  layers: [0, 1, 2].map(() => ({ format: RGBAFormat, mipmaps: [16, 8, 4].map((size) => new Uint8Array(size * size * 4)) })),
});

afterEach(() => {
  Lod.quality = 1;
  vi.restoreAllMocks();
});

/**
 * A scene of `objects` under a sun `height` above (0, 0, `z`), its shadow map `texels` square over `2 * extent` units,
 * over lit ground: a shadow map is drawn only for what receives it. Shadow maps are on until `dispose`.
 */
function sunlit(objects: Object3D[], { z = 0, height, texels, extent }: { z?: number; height: number; texels: number; extent: number }) {
  const sun = new DirectionalLight(0xffffff, 3);
  sun.position.set(0, height, z);
  sun.target.position.set(0, 0, z);
  sun.castShadow = true;
  sun.shadow.mapSize.set(texels, texels);
  Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 0.1, far: 2 * height });
  sun.shadow.camera.updateProjectionMatrix();
  const ground = new Mesh(new PlaneGeometry(2 * extent, 2 * extent).rotateX(-Math.PI / 2), new MeshStandardMaterial());
  ground.position.set(0, -2, z);
  ground.receiveShadow = true;
  renderer.shadowMap.enabled = true;
  const dispose = () => {
    renderer.shadowMap.enabled = false;
    sun.dispose();
    ground.geometry.dispose();
    ground.material.dispose();
  };
  return { scene: new Scene().add(...objects, ground, sun, sun.target), sun, dispose };
}

describe("InstancedLod", { timeout: GPU_TIMEOUT }, () => {
  it("chooses its levels at the height of the target it draws into, in the render that draws it", async () => {
    const lod = oneChunk([{ object: box("source") }, { object: new Group() }], onAxis([distanceAt(5)]));
    must(lod.levels[1]).maxPixels = 10;
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    try {
      // 5 px tall: the empty level, which draws nothing; 20 px on a target four times as tall: the source.
      await renderSorted(lod, camera);
      expect(await distances(lod, camera)).toEqual([[]]);
      await render(new Scene().add(lod), camera, SIZE * 4);
      expect(await distances(lod, camera)).toEqual([[Math.round(distanceAt(5))]]);
    } finally {
      lod.dispose();
    }
  });

  it("puts every instance into its level, and into both neighbours inside a fade, splitting its pixels", async () => {
    const heights = [100, 40 * (1 - Lod.fade / 2), 25, 10 * (1 - Lod.fade / 2), 5];
    const { lod, camera } = boxesAtHeights(heights);
    await renderSorted(lod, camera);
    const d = heights.map((h) => Math.round(distanceAt(h)));
    expect(await distances(lod, camera)).toEqual([
      [d[0], d[1]],
      [d[1], d[2], d[3]],
      [d[3], d[4]],
    ]);
    // Half way through the fade: the finer side draws the dither below 0.5, the coarser the rest.
    const [source, simplified] = await sortedLists(lod, camera);
    expect(source?.find((slot) => slot.distance === d[1])?.fade).toBeCloseTo(-0.5, 2);
    expect(simplified?.find((slot) => slot.distance === d[1])?.fade).toBeCloseTo(0.5, 2);
    expect(simplified?.find((slot) => slot.distance === d[2])?.fade).toBe(0);
    lod.dispose();
  });

  it("reports the level drawing most of each instance's pixels, and carries colours with the instances", async () => {
    const heights = [100, 40 * (1 - Lod.fade / 2), 5];
    const lod = oneChunk(
      [{ object: box("source") }, { object: box("simplified") }, { object: box("impostor") }],
      onAxis(heights.map((pixels) => distanceAt(pixels))),
      {
        colors: [new Color(1, 1, 1), new Color(1, 1, 1), new Color(1, 0, 0)],
      },
    );
    lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 40, 10][i] ?? level.maxPixels));
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    const chunk = chunkOf(lod);
    await renderSorted(lod, camera);
    expect([0, 1, 2].map((i) => chunk.getLevelAt(i, camera))).toEqual([0, 1, 2]);
    const byValue = (a: number | null, b: number | null) => (a ?? 0) - (b ?? 0);
    const colours = (await sortedLists(lod, camera)).map((level) => level.map((slot) => slot.color).sort(byValue));
    expect(colours).toEqual([[0xffffff, 0xffffff], [0xffffff], [0xff0000]]);
    // A colour set later follows its instance into the level it moves to.
    chunk.setColorAt(1, new Color(0, 0, 1));
    must(chunk.instanceColor).needsUpdate = true;
    lod.forceLevel = 2;
    await renderSorted(lod, camera);
    expect((await sortedLists(lod, camera))[2]?.map((slot) => slot.color).sort(byValue)).toEqual([0x0000ff, 0xff0000, 0xffffff]);
    lod.dispose();
  });

  it("measures an empty level 0 by the first level that draws, and draws nothing of it", async () => {
    const lod = oneChunk([{ object: new Group() }, { object: box("baked") }], onAxis([distanceAt(100), distanceAt(20)]));
    lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 40][i] ?? level.maxPixels));
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    await renderSorted(lod, camera);
    expect([0, 1].map((i) => chunkOf(lod).getLevelAt(i, camera))).toEqual([0, 1]);
    expect(await distances(lod, camera)).toEqual([[Math.round(distanceAt(20))]]);
    expect(() => new InstancedLod([{ object: new Group() }], pool)).toThrow(/no level has visible geometry/);
    lod.dispose();
  });

  it("scales heights by Lod.quality, draws only forceLevel, and nothing of an instance at scale 0", async () => {
    const { lod, camera, chunk } = boxesAtHeights([14, 100]);
    Lod.quality = 0.5;
    await renderSorted(lod, camera);
    expect((await distances(lod, camera)).map((list) => list.length)).toEqual([1, 0, 1]);
    lod.forceLevel = 1;
    chunk.setMatrixAt(1, new Matrix4().makeScale(0, 0, 0));
    chunk.instanceMatrix.needsUpdate = true;
    await renderSorted(lod, camera);
    expect((await distances(lod, camera)).map((list) => list.length)).toEqual([0, 1, 0]);
    expect(chunk.getLevelAt(1, camera)).toBe(null);
    lod.dispose();
  });

  it("takes in the instances an app moved in a live attribute, getLevelAt read in between", async () => {
    const { lod, camera, chunk } = boxesAtHeights([100, 100]);
    await renderSorted(lod, camera);
    chunk.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -distanceAt(5)));
    // Read from the attribute as it is, the edit not yet drawn.
    expect(chunk.getLevelAt(0, camera)).toBe(2);
    chunk.setMatrixAt(1, new Matrix4().makeTranslation(0, 0, -distanceAt(25)));
    chunk.instanceMatrix.addUpdateRange(16, 16);
    chunk.instanceMatrix.needsUpdate = true;
    await renderSorted(lod, camera);
    // Only the range marked uploaded: the first edit waits for its own.
    expect(await distances(lod, camera)).toEqual([[Math.round(distanceAt(100))], [Math.round(distanceAt(25))], []]);
    expect(chunk.instanceMatrix.updateRanges).toEqual([]);
    chunk.instanceMatrix.needsUpdate = true;
    await renderSorted(lod, camera);
    expect(await distances(lod, camera)).toEqual([[], [Math.round(distanceAt(25))], [Math.round(distanceAt(5))]]);
    lod.dispose();
  });
});

describe("an InstancedLod in shadow maps", { timeout: GPU_TIMEOUT }, () => {
  it("draws only the instances in each camera, and into a shadow map each at the level its texels resolve", async () => {
    // 50 px tall in camera: the source. Behind the camera, it is in the shadow map only; far aside, in neither.
    const lod = oneChunk(
      [{ object: box("source") }, { object: box("simplified") }, { object: box("impostor") }],
      [
        new Matrix4().makeTranslation(0, 0, -distanceAt(50)),
        new Matrix4().makeTranslation(0, 0, distanceAt(50)),
        new Matrix4().makeTranslation(200, 0, -distanceAt(50)),
      ],
    );
    lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 40, 10][i] ?? level.maxPixels));
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    lod.traverse((node) => (node.castShadow = true));
    // 64 texels over 32 units: the box, about 3.5 units across, is 7 texels: the coarsest level.
    const { scene, sun, dispose } = sunlit([lod], { z: -distanceAt(50), height: 50, texels: 64, extent: 16 });
    try {
      for (let i = 0; i < 2; i++) await render(scene, camera, SIZE);
      expect(await distances(lod, camera)).toEqual([[Math.round(distanceAt(50))], [], []]);
      expect((await distances(lod, sun.shadow.camera)).map((list) => list.length)).toEqual([0, 0, 2]);
    } finally {
      dispose();
      lod.dispose();
    }
  });

  it("holds a shadow map's lists however seldom the map is redrawn, until its target is disposed", async () => {
    const lod = oneChunk([{ object: box("source") }], onAxis([distanceAt(50)]));
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    lod.traverse((node) => (node.castShadow = true));
    const { scene, sun, dispose } = sunlit([lod], { z: -distanceAt(50), height: 50, texels: 64, extent: 16 });
    sun.shadow.autoUpdate = false;
    const mesh = must(drawnMeshes(lod)[0]);
    const listsOf = () => drawnSlots(mesh, sun.shadow.camera).indices;
    try {
      let first: BufferAttribute | null = null;
      for (let frame = 0; frame < 18; frame++) {
        sun.shadow.needsUpdate = frame % 8 === 0;
        await render(scene, camera, SIZE);
        await new Promise(requestAnimationFrame);
        if (frame === 1) first = listsOf();
      }
      expect(first).not.toBeNull();
      expect(listsOf()).toBe(first);
      expect(await distances(lod, sun.shadow.camera)).toEqual([[Math.round(distanceAt(50))]]);
      // Its target disposed, the map draws nothing: the next render gives its lists back. That render leaves out the
      // ground, whose material would sample the destroyed map.
      sun.shadow.dispose();
      await render(new Scene().add(lod), camera, SIZE);
      expect(listsOf()).not.toBe(first);
    } finally {
      dispose();
      lod.dispose();
    }
  });

  it("sorts for a shadow map an InstancedLod outside its camera whose shadow falls on the ground in sight", async () => {
    const source = box();
    source.castShadow = true;
    const lod = oneChunk([{ object: source }], 1);
    lod.position.set(4, 4, 0);
    // Lit ground under a sun, a world of its own for each render: one shadow map never stands in for another's.
    const made: { dispose(): void }[] = [];
    const world = () => {
      const ground = new Mesh(new PlaneGeometry(24, 24).rotateX(-Math.PI / 2), new MeshStandardMaterial());
      ground.receiveShadow = true;
      const sun = new DirectionalLight(0xffffff, 3);
      sun.position.set(12, 12, 0);
      sun.castShadow = true;
      sun.shadow.mapSize.set(256, 256);
      Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 0.1, far: 50 });
      sun.shadow.camera.updateProjectionMatrix();
      made.push(ground.geometry, ground.material, sun);
      return new Scene().add(ground, sun, sun.target, new AmbientLight(0xffffff, 0.2));
    };
    const camera = new OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
    camera.position.set(0, 20, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    renderer.shadowMap.enabled = true;
    try {
      const shadow = await render(world().add(lod), camera);
      const lit = await render(world(), camera.clone());
      const center = (32 * 64 + 32) * 4;
      expect(shadow[center]).toBeLessThan((lit[center] ?? 0) * 0.8);
    } finally {
      renderer.shadowMap.enabled = false;
      lod.dispose();
      for (const each of made) each.dispose();
    }
  });
});

describe("an InstancedLod's chunks", { timeout: GPU_TIMEOUT }, () => {
  it("adds and removes chunks, each drawing its own colours or white", async () => {
    const lod = new InstancedLod([{ object: box("source") }], pool);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    try {
      const a = lod.addChunk({ instanceMatrix: instanceMatrix(onAxis([10, 11])) });
      const b = lod.addChunk({ instanceMatrix: instanceMatrix(onAxis([20])) });
      await renderSorted(lod, camera);
      expect(await distances(lod, camera)).toEqual([[10, 11, 20]]);
      lod.removeChunk(a);
      expect(() => lod.removeChunk(a)).toThrow(/not one of its chunks/);
      expect(() => a.getLevelAt(0, camera)).toThrow(/removed/);
      const c = lod.addChunk({ instanceMatrix: instanceMatrix(onAxis([30])), instanceColor: instanceColor([new Color(1, 0, 0)]) });
      // A range of the attributes: the middle three.
      const d = lod.addChunk({ instanceMatrix: instanceMatrix(onAxis([39, 40, 41, 42, 43])), start: 1, count: 3 });
      expect([...lod.chunks]).toEqual([b, c, d]);
      await renderSorted(lod, camera);
      expect(await distances(lod, camera)).toEqual([[20, 30, 40, 41, 42]]);
      const colours = (await sortedLists(lod, camera))[0]?.map(({ distance, color }): [number, number | null] => [distance, color]);
      expect(new Map(colours)).toEqual(
        new Map([
          [20, 0xffffff],
          [30, 0xff0000],
          [40, 0xffffff],
          [41, 0xffffff],
          [42, 0xffffff],
        ]),
      );
      expect(d.getLevelAt(2, camera)).toBe(0);
      expect(d.getMatrixAt(1, new Matrix4()).elements[14]).toBe(-41);
      // Without chunks, nothing is in the camera's frustum: nothing draws.
      for (const chunk of [b, c, d]) lod.removeChunk(chunk);
      await renderSorted(lod, camera);
      expect(drawnMeshes(lod).map((mesh) => mesh.visible)).toEqual([false]);
    } finally {
      lod.dispose();
    }
  });

  it("renders before its first chunk, then draws the chunks added after", async () => {
    const lod = new InstancedLod([{ object: box("source") }], pool);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    const errors = vi.spyOn(console, "error");
    try {
      await renderSorted(lod, camera);
      lod.addChunk({ instanceMatrix: instanceMatrix(onAxis([10, 20])) });
      await renderSorted(lod, camera);
      expect(await distances(lod, camera)).toEqual([[10, 20]]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      lod.dispose();
    }
  });

  it("reads an attribute two chunks share through one buffer, an edit reaching both", async () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 1e5);
    /** Storage buffers made by the first sort of an InstancedLod with two chunks over `attributes`. */
    const buffers = async (attributes: [ReturnType<typeof instanceMatrix>, ReturnType<typeof instanceMatrix>]) => {
      const lod = new InstancedLod([{ object: box("source") }], pool);
      const chunks = [lod.addChunk({ instanceMatrix: attributes[0], count: 2 }), lod.addChunk({ instanceMatrix: attributes[1], start: 2, count: 2 })];
      const before = renderer.info.memory.storageAttributes;
      await renderSorted(lod, camera);
      return { lod, chunks, made: renderer.info.memory.storageAttributes - before };
    };
    const own = await buffers([instanceMatrix(onAxis([10, 11, 12, 13])), instanceMatrix(onAxis([10, 11, 12, 13]))]);
    own.lod.dispose();
    const shared = instanceMatrix(onAxis([10, 11, 12, 13]));
    const { lod, chunks, made } = await buffers([shared, shared]);
    try {
      expect(made).toBe(own.made - 1);
      expect(await distances(lod, camera)).toEqual([[10, 11, 12, 13]]);
      const [a, b] = chunks;
      must(a).setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -20));
      must(b).setMatrixAt(1, new Matrix4().makeTranslation(0, 0, -30));
      shared.needsUpdate = true;
      await renderSorted(lod, camera);
      expect(await distances(lod, camera)).toEqual([[11, 12, 20, 30]]);
      expect(must(b).maxScale).toBe(1);
      lod.removeChunk(must(a));
      must(b).setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -40));
      shared.needsUpdate = true;
      await renderSorted(lod, camera);
      expect(await distances(lod, camera)).toEqual([[30, 40]]);
    } finally {
      lod.dispose();
    }
  });

  it("copies its CPU chunks into a clone of their own", () => {
    const lod = oneChunk([{ object: box() }], onAxis([5, 6]), { maxInstanceCount: 512 });
    lod.cullDistance = { camera: camera(), near: 10, far: 20 };
    const clone = lod.clone();
    const copied = chunkOf(clone);
    expect(copied.instanceMatrix).not.toBe(chunkOf(lod).instanceMatrix);
    expect(copied.getMatrixAt(1, new Matrix4()).elements[14]).toBe(-6);
    expect(clone.cullDistance).toEqual(lod.cullDistance);
    clone.dispose();
    lod.dispose();
  });
});

describe("an InstancedLod's level loads", { timeout: GPU_TIMEOUT }, () => {
  it("loads shared decoded detail only in InstancedLods near enough to draw it", async () => {
    // Memoized, as a load shared across Lods is to share one object.
    const make = vi.fn(async () => box());
    let made: Promise<Mesh> | undefined;
    const deferred = { load: () => (made ??= make()), maxPixels: Infinity, box: new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)) };
    const levels = [deferred, { object: box(), maxPixels: 5 }];
    const near = oneChunk(levels, onAxis([5]));
    const away = oneChunk(levels, onAxis([1000]));
    const camera = new PerspectiveCamera(60, 1, 0.1, 2000);
    const scene = new Scene().add(near, away);
    try {
      const nearLoaded = nextLevel(near, camera);
      await render(scene, camera);
      await nearLoaded;
      expect(drawnMeshes(near)).toHaveLength(2);
      expect(drawnMeshes(away)).toHaveLength(1);
      expect(away.pending).toBe(false);

      camera.position.z = -995;
      camera.updateMatrixWorld();
      const awayLoaded = nextLevel(away, camera);
      await render(scene, camera);
      await awayLoaded;
      expect(drawnMeshes(away)).toHaveLength(2);
      expect(make).toHaveBeenCalledOnce();
    } finally {
      near.dispose();
      away.dispose();
    }
  });

  it("loads the levels its shadow map draws, for casters in camera and behind it", async () => {
    const bounds = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
    const source = box();
    source.castShadow = true;
    const coarse = { load: async () => Object.assign(box(), { castShadow: true }), maxPixels: 20, box: bounds };
    // One in camera, near enough for its source; one behind the camera, casting into its picture.
    const lod = oneChunk([{ object: source }, coarse], onAxis([5, -5]));
    lod.traverse((node) => (node.castShadow = true));
    // Too coarse to need the source: about 5 texels a metre.
    const { scene, sun, dispose } = sunlit([lod], { height: 20, texels: 128, extent: 12 });
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    try {
      await render(scene, camera);
      await nextLevel(lod, camera);
      // Three draws a shadow map once a frame: renders of the frame the level joined in show the map drawn before it.
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await render(scene, camera);
      }
      expect(lod.pending).toBe(false);
      expect(await distances(lod, camera)).toEqual([[5], []]);
      expect(await distances(lod, sun.shadow.camera)).toEqual([[], [-5, 5]]);
    } finally {
      dispose();
      lod.dispose();
    }
  });

  it("joins no level in a shadow map rendered after its camera in a frame, so the camera's draws stay", async () => {
    const bounds = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
    const casting = (name: string) => Object.assign(box(), { castShadow: true, name });
    let release = () => {};
    const fine = new Promise<Mesh>((resolve) => (release = () => resolve(casting("fine"))));
    // The coarse level loads first and arrives; the fine one waits for that arrival to fade in, on a clock held still.
    const lod = oneChunk(
      [
        { load: () => fine, maxPixels: Infinity, box: bounds },
        { load: async () => casting("coarse"), maxPixels: 5, box: bounds },
      ],
      onAxis([5, 1000]),
    );
    const { scene, sun, dispose } = sunlit([lod], { height: 20, texels: 64, extent: 12 });
    const camera = new PerspectiveCamera(60, 1, 0.1, 2000);
    let now = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    // Armed, the shadow map's update finds the fade over: the fine level would join there, after the camera sorted.
    let armed = false;
    const update = lod.update.bind(lod);
    vi.spyOn(lod, "update").mockImplementation((updated) => {
      if (armed && updated === sun.shadow.camera) now += ARRIVAL_MS;
      update(updated);
    });
    const compile = renderer.compileAsync.bind(renderer);
    let fineCompiled = false;
    vi.spyOn(renderer, "compileAsync").mockImplementation(async (object, ...rest) => {
      await compile(object, ...rest);
      if (object.name === "fine") fineCompiled = true;
    });
    try {
      // On the canvas throughout: a target of its own for each render would compile the levels for it again.
      await eventually(() => {
        renderer.render(scene, camera);
        expect(lod.levels[1]?.object).toBeDefined();
      });
      release();
      await eventually(() => {
        renderer.render(scene, camera);
        expect(fineCompiled).toBe(true);
      });
      // The fine level is ready, waiting for the fade.
      expect(lod.levels[0]?.object).toBeUndefined();
      // A frame of its own: shadow maps render once per animation frame.
      await new Promise(requestAnimationFrame);
      armed = true;
      renderer.render(scene, camera);
      armed = false;
      expect(lod.levels[0]?.object).toBeUndefined();
      // The coarse level draws both while the fine one waits.
      expect(await distances(lod, camera)).toEqual([[5, 1000]]);
      // The camera's next update joins it.
      renderer.render(scene, camera);
      expect(lod.levels[0]?.object).toBeDefined();
    } finally {
      dispose();
      lod.dispose();
    }
  });
});

const shear = new Matrix4().set(1, 0.9, 0.9, 0, 0.9, 1, 0.9, 0, 0.9, 0.9, 1, 0, 0, 0, 0, 1);

function camera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.z = 100;
  camera.updateMatrixWorld();
  return camera;
}

/** Whether every level mesh's bounds hold every vertex it draws for an instance at `matrix`, swayed by `sway`. */
function contains(lod: InstancedLod, matrix: Matrix4, sway = 0): void {
  const point = new Vector3();
  for (const mesh of drawnMeshes(lod)) {
    const sphere = must(mesh.geometry.boundingSphere);
    const bounds = sphere.clone().applyMatrix4(lod.matrixWorld);
    const vertices = mesh.geometry.getAttribute("position");
    for (let i = 0; i < vertices.count; i++) {
      for (const direction of [-1, 1]) {
        point.fromBufferAttribute(vertices, i);
        point.x += direction * point.y * sway;
        point.applyMatrix4(matrix).applyMatrix4(lod.matrixWorld);
        expect(bounds.containsPoint(point)).toBe(true);
      }
    }
  }
}

describe("an InstancedLod's bounds", { timeout: GPU_TIMEOUT }, () => {
  it("is bounded, for three's Box3.setFromObject, around every instance at every level, an impostor card's level too", () => {
    const tall = Object.assign(new Mesh(new BoxGeometry(2, 10, 2), new MeshBasicMaterial()), { name: "tall" });
    tall.position.y = 5;
    const lod = new InstancedLod([{ object: box("source") }, { object: tall }, { object: new ImpostorMesh(impostor()) }], pool);
    const spots = [new Matrix4().makeTranslation(-30, 0, 0), new Matrix4().makeScale(2, 2, 2).setPosition(30, 0, 5)];
    lod.addChunk({ instanceMatrix: instanceMatrix(spots) });
    lod.position.set(0, 100, 0);
    lod.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(lod);
    expect([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)).toBe(true);
    // Each instance's every level, where the InstancedLod stands.
    for (const spot of spots) {
      const placed = spot.clone().premultiply(lod.matrixWorld);
      expect(bounds.containsBox(new Box3().setFromObject(tall).applyMatrix4(placed))).toBe(true);
      expect(bounds.containsBox(new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)).applyMatrix4(placed))).toBe(true);
    }
    lod.dispose();
  });

  it("bounds every placed level and a sheared template, still choosing levels by the source's sphere", () => {
    const material = new MeshBasicMaterial();
    const source = new Mesh(new BoxGeometry(2, 2, 2), material);
    source.matrixAutoUpdate = false;
    source.matrix.copy(shear);
    source.updateMatrixWorld(true);
    const coarse = new Mesh(new BoxGeometry(20, 10, 2), material);
    coarse.position.set(30, 10, 0);
    coarse.geometry.computeTangents();
    const lod = oneChunk([{ object: source }, { object: coarse }], 1);
    const translated = must(drawnMeshes(lod)[1]);
    expect(new Vector3().fromBufferAttribute(translated.geometry.getAttribute("position"), 0).toArray()).toEqual([40, 15, 1]);
    expect(new Vector3().fromBufferAttribute(coarse.geometry.getAttribute("position"), 0).toArray()).toEqual([10, 5, 1]);
    for (const name of ["normal", "tangent"]) expect(translated.geometry.getAttribute(name).array).toEqual(coarse.geometry.getAttribute(name).array);
    must(lod.levels[1]).maxPixels = 70;
    updateInRender(lod, camera());
    // The source's max-axis sphere gives ~52px. Using the full geometry envelope would choose level zero here.
    expect(chunkOf(lod).getLevelAt(0, camera())).toBe(1);
    contains(lod, new Matrix4());
    lod.dispose();

    const sheared = oneChunk([{ object: source }, { object: coarse }], [shear]);
    sheared.matrixAutoUpdate = false;
    sheared.matrix.copy(shear);
    sheared.updateMatrixWorld(true);
    contains(sheared, shear);
    sheared.dispose();
  });

  it("bounds the sway of a taller coarse level, in a clone too", () => {
    const material = new MeshBasicMaterial();
    const source = new Mesh(new BoxGeometry(2, 0, 2), material);
    const coarse = new Mesh(new BoxGeometry(2, 100, 2), material);
    coarse.position.y = 50;
    const lod = oneChunk([{ object: source }, { object: coarse }], [shear]);
    const wind = new Wind();
    wind.apply(lod, { amplitude: 1, baseY: 0, height: 1 });
    lod.matrixAutoUpdate = false;
    lod.matrix.copy(shear);
    lod.updateMatrixWorld(true);
    // Source is flat at the wind base, but the coarse top can move 100 units.
    contains(lod, shear, 1);
    const clone = lod.clone();
    clone.updateMatrixWorld(true);
    contains(clone, shear, 1);
    clone.dispose();
    lod.dispose();
  });
});

describe("an InstancedLod's shaders", { timeout: GPU_TIMEOUT }, () => {
  it("builds the same shaders for InstancedLods made apart from alike materials, so that they share programs", async () => {
    const first = oneChunk([{ object: box() }], 1, { colors: [new Color("red")] });
    const scene = new Scene().add(first);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 5;
    await render(scene, camera);
    const draw = must(drawnMeshes(first)[0]);
    const before = await renderer.debug.getShaderAsync(scene, camera, draw);
    // Unrelated asynchronous asset arrivals allocate nodes between equivalent InstancedLods.
    for (let i = 0; i < 23; i++) uniform(i);
    const second = oneChunk([{ object: box() }], 17);
    scene.add(second);
    try {
      await render(scene, camera);
      const after = await renderer.debug.getShaderAsync(scene, camera, must(drawnMeshes(second)[0]));
      expect(before.vertexShader).toContain("lodInstanceMatrices");
      expect(after.vertexShader).toBe(before.vertexShader);
      expect(after.fragmentShader).toBe(before.fragmentShader);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("draws colours set after its first draws without building its shaders again", async () => {
    const lod = oneChunk([{ object: box() }], 1, { colors: [new Color(1, 1, 1)] });
    const scene = new Scene().add(lod);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 5;
    try {
      await render(scene, camera);
      await render(scene, camera);
      const chunk = chunkOf(lod);
      chunk.setColorAt(0, new Color(1, 0, 0));
      must(chunk.instanceColor).needsUpdate = true;
      const builds = vi.spyOn(NodeMaterial.prototype, "setup");
      const pixels = await render(scene, camera);
      expect(builds).not.toHaveBeenCalled();
      expect(Array.from(pixels.slice((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4))).toEqual([255, 0, 0, 255]);
    } finally {
      lod.dispose();
    }
  });
});

describe("renderers", () => {
  /** A renderer the app never added to Lod.renderers, as a loader's own would be. */
  const unknownRenderer = async () => {
    const other = new WebGPURenderer({ antialias: false });
    await other.init();
    return other;
  };

  it("draws nothing for a renderer it does not know, then draws with the first of Lod.renderers that renders it", { timeout: GPU_TIMEOUT }, async () => {
    const other = await unknownRenderer();
    const lod = oneChunk([{ object: box() }], 1);
    const scene = new Scene().add(lod);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 5;
    try {
      expect(() => chunkOf(lod).getLevelAt(0, camera)).toThrow(/render the InstancedLod first/);
      other.render(scene, camera);
      expect(lod.error).toBeUndefined();
      await eventually(async () => expect((await render(scene, camera)).some((value) => value > 0)).toBe(true));
      expect(chunkOf(lod).getLevelAt(0, camera)).toBe(0);
    } finally {
      lod.dispose();
      other.dispose();
    }
  });

  it("reports another renderer than the first that drew it as its error, and goes on drawing with the first", { timeout: GPU_TIMEOUT }, async () => {
    const other = await unknownRenderer();
    const lod = oneChunk([{ object: box() }], 1);
    const scene = new Scene().add(lod);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 5;
    const failed = vi.fn();
    lod.addEventListener("levelserror", ({ error }) => failed(error));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let i = 0; i < 2; i++) await render(scene, camera);
      expect(lod.error).toBeUndefined();
      other.render(scene, camera);
      expect(lod.error?.message).toMatch(/another renderer than the first that rendered it drew it/);
      expect(failed).toHaveBeenCalledWith(lod.error);
      expect(logged).toHaveBeenCalledWith(lod.error);
      expect((await render(scene, camera)).some((value) => value > 0)).toBe(true);
    } finally {
      logged.mockRestore();
      lod.dispose();
      other.dispose();
    }
  });
});

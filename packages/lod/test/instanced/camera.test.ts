import { Group, Matrix4, OrthographicCamera, PerspectiveCamera, Scene } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Lod } from "../../src/lod.js";
import { GPU_TIMEOUT, render, renderer } from "../renderer.js";
import { drawnSlots, lodOf } from "../instances.js";
import { must } from "../must.js";
import { box } from "../box.js";
import { SIZE, distanceAt, distances, sortedLists, drawnMeshes, onAxis, boxesAtHeights, renderSorted } from "./fixture.js";

afterEach(() => vi.restoreAllMocks());

describe("a Lod's cameras", { timeout: GPU_TIMEOUT }, () => {
  it("sorts for two cameras before either draws, each drawing its own instances", async () => {
    // One instance ahead of each camera: `ahead` looks down -z, `behind` down +z.
    const lod = lodOf(
      [{ object: box("source") }, { object: box("simplified") }, { object: box("impostor") }],
      [new Matrix4().makeTranslation(0, 0, -distanceAt(100)), new Matrix4().makeTranslation(0, 0, distanceAt(20))],
    );
    lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 40, 10][i] ?? level.maxPixels));
    const ahead = new PerspectiveCamera(60, 1, 0.1, 1e5);
    const behind = new PerspectiveCamera(60, 1, 0.1, 1e5);
    behind.rotation.y = Math.PI;
    const scene = new Scene().add(lod);
    try {
      await renderSorted(lod, ahead);
      await renderSorted(lod, behind);
      // Both move, the first back until its instance draws simplified, and both update before either draws: each
      // camera's row is its own, so neither sort runs before its camera draws.
      ahead.position.z = distanceAt(30) - distanceAt(100);
      behind.position.x = 0.5;
      for (const camera of [ahead, behind]) camera.updateMatrixWorld();
      scene.updateMatrixWorld();
      const compute = vi.spyOn(renderer, "compute");
      lod.update(ahead);
      expect(compute).not.toHaveBeenCalled();
      lod.update(behind);
      expect(compute).not.toHaveBeenCalled();
      // Each camera's draws run its sort.
      lod.autoUpdate = false;
      for (const camera of [ahead, behind]) await render(scene, camera, SIZE);
      expect(compute).toHaveBeenCalledTimes(2);
      expect(await distances(lod, ahead)).toEqual([[], [Math.round(distanceAt(100))], []]);
      expect(await distances(lod, behind)).toEqual([[], [-Math.round(distanceAt(20))], []]);
    } finally {
      lod.dispose();
    }
  });

  it("shows for each camera only the level meshes its instances can draw, every level they draw among them", async () => {
    const { lod, camera } = boxesAtHeights([100]);
    const scene = new Scene().add(lod);
    /** Per level, whether its mesh is shown; each level with an instance in its lists is. */
    const shown = async () => {
      const drawn = (await sortedLists(lod, camera)).map((level) => level.length);
      const visible = drawnMeshes(lod).map((mesh) => mesh.visible);
      drawn.forEach((count, level) => count > 0 && expect(visible[level], `level ${level} draws ${count}`).toBe(true));
      return visible;
    };
    try {
      await renderSorted(lod, camera);
      expect(await shown()).toEqual([true, false, false]);
      // Backing away: inside the simplified level's fade, then the simplified level alone, then the impostor's fade and
      // the impostor alone.
      const expected: [number, boolean[]][] = [
        [40 * (1 - Lod.fade / 2), [true, true, false]],
        [25, [false, true, false]],
        [10 * (1 - Lod.fade / 2), [false, true, true]],
        [5, [false, false, true]],
      ];
      for (const [pixels, visible] of expected) {
        camera.position.z = distanceAt(pixels) - distanceAt(100);
        await render(scene, camera, SIZE);
        expect(await shown(), `${pixels} px`).toEqual(visible);
      }
    } finally {
      lod.dispose();
    }
  });

  it("sorts again for a camera or a parent that moved", async () => {
    const { lod, camera } = boxesAtHeights([100]);
    const parent = new Group().add(lod);
    await renderSorted(lod, camera);
    expect((await distances(lod, camera)).map((list) => list.length)).toEqual([1, 0, 0]);
    parent.position.z = -distanceAt(5) + distanceAt(100);
    await renderSorted(lod, camera);
    expect((await distances(lod, camera)).map((list) => list.length)).toEqual([0, 0, 1]);
    camera.position.z = -distanceAt(5) + distanceAt(100);
    await renderSorted(lod, camera);
    expect((await distances(lod, camera)).map((list) => list.length)).toEqual([1, 0, 0]);
    lod.dispose();
  });

  it("sorts no more for a camera moving about while every instance draws one level wholly inside its frustum", async () => {
    const { lod, camera } = boxesAtHeights([20, 25]);
    const scene = new Scene().add(lod);
    try {
      await renderSorted(lod, camera);
      const compute = vi.spyOn(renderer, "compute");
      camera.position.set(0.2, 0, -0.5);
      await render(scene, camera, SIZE);
      expect(compute).not.toHaveBeenCalled();
      expect(await distances(lod, camera)).toEqual([[], [Math.round(distanceAt(25)), Math.round(distanceAt(20))], []]);
      // Near enough for the nearer one to draw its source: they no longer draw alike.
      camera.position.set(0, 0, distanceAt(50) - distanceAt(25));
      await render(scene, camera, SIZE);
      expect(compute).toHaveBeenCalledTimes(1);
      expect((await distances(lod, camera)).map((list) => list.length)).toEqual([1, 1, 0]);
    } finally {
      lod.dispose();
    }
  });

  it("goes on drawing what a camera's first sort wrote into a slice of a buffer bound already, while it skips its sorts", async () => {
    const { lod, camera } = boxesAtHeights([20, 25]);
    const second = camera.clone();
    second.position.x = 0.2;
    const scene = new Scene().add(lod);
    try {
      await renderSorted(lod, camera);
      // The second camera's slice lies in the buffer the first one's draws bound.
      await renderSorted(lod, second);
      const compute = vi.spyOn(renderer, "compute");
      for (let i = 0; i < 3; i++) await render(scene, second, SIZE);
      expect(compute).not.toHaveBeenCalled();
      expect(await distances(lod, second)).toEqual([[], [Math.round(distanceAt(25)), Math.round(distanceAt(20))], []]);
    } finally {
      lod.dispose();
    }
  });

  it("sorts no more for an orthographic camera moving about while its instances lie wholly inside its frustum", async () => {
    // 4 px a unit: the one 4 times as large draws its source, the other its simplified level.
    const lod = lodOf(
      [{ object: box("source") }, { object: box("simplified") }, { object: box("impostor") }],
      [new Matrix4().makeScale(4, 4, 4).setPosition(0, 0, -10), new Matrix4().makeTranslation(0, 0, -30)],
    );
    lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 40, 10][i] ?? level.maxPixels));
    const camera = new OrthographicCamera(-8, 8, 8, -8, 0.1, 100);
    const scene = new Scene().add(lod);
    try {
      await renderSorted(lod, camera);
      expect(await distances(lod, camera)).toEqual([[10], [30], []]);
      const compute = vi.spyOn(renderer, "compute");
      camera.position.x = 0.5;
      await render(scene, camera, SIZE);
      expect(compute).not.toHaveBeenCalled();
      // Across its frustum's edge, it sorts again.
      camera.position.x = 3;
      await render(scene, camera, SIZE);
      expect(compute).toHaveBeenCalledTimes(1);
      expect(await distances(lod, camera)).toEqual([[10], [30], []]);
    } finally {
      lod.dispose();
    }
  });

  it("skips a camera's sort while nothing it reads changed, and every sort while it looks away", async () => {
    const { lod, camera } = boxesAtHeights([100]);
    const scene = new Scene().add(lod);
    try {
      await renderSorted(lod, camera);
      const compute = vi.spyOn(renderer, "compute");
      await render(scene, camera, SIZE);
      expect(compute).not.toHaveBeenCalled();
      camera.position.x = 0.5;
      await render(scene, camera, SIZE);
      // The sort and the copy of its counts, in one call.
      expect(compute).toHaveBeenCalledTimes(1);
      // Looking away from afar, the camera draws nothing and sorts nothing, however it turns about.
      const shown = () => drawnMeshes(lod).map((mesh) => mesh.visible);
      camera.position.z = 10;
      camera.rotation.y = Math.PI;
      await render(scene, camera, SIZE);
      expect(shown()).toEqual([false, false, false]);
      camera.position.x = 2;
      camera.rotation.y = Math.PI * 0.9;
      await render(scene, camera, SIZE);
      expect(compute).toHaveBeenCalledTimes(1);
      // Back where it last sorted, the lists that sort wrote draw again, unsorted; a step aside sorts again.
      camera.position.set(0.5, 0, 0);
      camera.rotation.y = 0;
      await render(scene, camera, SIZE);
      expect(compute).toHaveBeenCalledTimes(1);
      expect(shown()).toEqual([true, false, false]);
      camera.position.x = 0.25;
      await render(scene, camera, SIZE);
      expect(compute).toHaveBeenCalledTimes(2);
      expect(await distances(lod, camera)).toEqual([[Math.round(distanceAt(100))], [], []]);
    } finally {
      lod.dispose();
    }
  });

  it("gives back the lists of a camera that stopped rendering it", async () => {
    const lod = lodOf([{ object: box("source") }], onAxis([5]));
    const scene = new Scene().add(lod);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const once = camera.clone();
    try {
      // The first render learns the renderer, the second sorts.
      for (let i = 0; i < 2; i++) await render(scene, once);
      const freed = vi.fn();
      drawnSlots(must(drawnMeshes(lod)[0]), once).indices.addEventListener("dispose", freed);
      // Two rounds of another camera: the one-frame clone no longer renders it.
      for (let i = 0; i < 3; i++) await render(scene, camera);
      expect(freed).toHaveBeenCalledOnce();
    } finally {
      lod.dispose();
    }
  });
});

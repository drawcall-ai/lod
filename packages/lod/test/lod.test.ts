import {
  Box3,
  BoxGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  type Camera,
} from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fadeSourceOf } from "../src/levels/fade.js";
import { ARRIVAL_MS } from "../src/levels/manager.js";
import { Lod } from "../src/lod.js";
import { box } from "./box.js";
import { GPU_TIMEOUT, render, renderer, nextLevel, updateInRender } from "./renderer.js";

/** Bounding diameter of `box()`: the box diagonal. */
const DIAMETER = 2 * Math.sqrt(3);
const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
const tan = Math.tan(Math.PI / 6);

/** A source and two levels used up to 400 and 100 px tall. */
function lod(): Lod {
  const result = new Lod([{ object: box() }, { object: box() }, { object: box() }]);
  setMaxPixels(result, [400, 100]);
  return result;
}

function setMaxPixels(target: Lod, values: number[]): void {
  values.forEach((value, i) => {
    const level = target.levels[i + 1];
    if (!level) throw new Error(`no level ${i + 1}`);
    level.maxPixels = value;
  });
}

/** The canvas's height, which a Lod measures on in a render without a target. */
const CANVAS = renderer.getSize(new Vector2()).y;

/** Place `camera` where the bounding sphere is `pixels` tall on a `height` px screen. */
function place(pixels: number, height = CANVAS, from: Camera = camera): void {
  from.position.set(0, 0, (DIAMETER * height) / (2 * tan * pixels));
  from.updateMatrixWorld();
}

/** Update `target` in a render, seen where it is `pixels` tall on the canvas. */
function seenAt(target: Lod, pixels: number, from: Camera = camera): Lod {
  place(pixels, CANVAS, from);
  target.updateMatrixWorld();
  updateInRender(target, from);
  return target;
}

const visible = (target: Lod) => target.levels.flatMap(({ object }, i) => (object?.visible ? [i] : []));
/** The signed fade level `i` of `target` draws with (see fade.ts). */
const fadeOf = (target: Lod, i: number) => {
  const object = target.levels[i]?.object;
  const draw = object && fadeSourceOf(object);
  if (draw?.kind !== "object") throw new Error(`level ${i} has no draw`);
  return draw.fade;
};

afterEach(() => {
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  Lod.quality = 1;
  Lod.debug = false;
});

describe("Lod", { timeout: GPU_TIMEOUT }, () => {
  it("switches at maxPixels, measured from subtense, fov and screen height, times quality", () => {
    const target = lod();
    expect(visible(seenAt(target, 100.01))).toEqual([1]);
    expect(visible(seenAt(target, 99.99))).toEqual([1, 2]);
    camera.zoom = 2;
    camera.updateProjectionMatrix();
    // Twice as tall on screen: 50.01 px of the unzoomed camera is above level 2's 100.
    expect(visible(seenAt(target, 50.01))).toEqual([1]);
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    expect(visible(seenAt(target, 140))).toEqual([1]);
    Lod.quality = 0.5;
    expect(visible(seenAt(target, 140))).toEqual([2]);
  });

  it("shows the levels levelsToDraw names, the coarser fading by its fade and the finer by its negation", () => {
    const target = lod();
    expect(visible(seenAt(target, 250))).toEqual([1]);
    expect(fadeOf(target, 1)).toBe(0);
    expect(visible(seenAt(target, 400 * (1 - Lod.fade / 2)))).toEqual([0, 1]);
    expect(fadeOf(target, 1)).toBeCloseTo(0.5, 6);
    expect(fadeOf(target, 0)).toBe(-fadeOf(target, 1));
    expect(fadeOf(target, 2)).toBe(0);
  });

  it("switches at once in an orthographic camera", () => {
    const ortho = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    // Taller than level 1's maxPixels.
    ortho.zoom = 1080 / CANVAS;
    ortho.updateProjectionMatrix();
    expect(visible(seenAt(lod(), 1, ortho))).toEqual([0]);
    // Inside level 1's fade, which an orthographic camera skips.
    ortho.zoom = (400 * (1 - Lod.fade / 2) * 2) / (DIAMETER * CANVAS);
    ortho.updateProjectionMatrix();
    expect(visible(seenAt(lod(), 1, ortho))).toEqual([1]);
  });

  it("leaves a nested Lod's levels to it and switches to it at once", () => {
    const outer = new Lod([{ object: box() }, { object: new Lod([{ object: box() }, { object: box() }]) }]);
    const inner = outer.levels[1]?.object;
    if (!(inner instanceof Lod)) throw new Error("Missing nested Lod");
    setMaxPixels(outer, [400]);
    seenAt(outer, 1000);
    expect([outer.levels[0]?.object?.visible, inner.visible]).toEqual([true, false]);
    seenAt(outer, 400 * (1 - Lod.fade / 2));
    expect([outer.levels[0]?.object?.visible, inner.visible]).toEqual([false, true]);
    expect(inner.levels.map(({ object }) => object?.visible)).toEqual([true, true]);
  });

  it("raycasts the source only", () => {
    const source = box();
    const level = box();
    level.position.x = 10;
    const target = new Lod([{ object: source }, { object: level }]);
    target.updateMatrixWorld();
    const hits = new Raycaster(new Vector3(0.3, 0.2, 10), new Vector3(0, 0, -1)).intersectObject(target);
    expect(hits.map((hit) => hit.object)).toEqual([target.levels[0]?.object]);
    expect(new Raycaster(new Vector3(10.3, 0.2, 10), new Vector3(0, 0, -1)).intersectObject(target)).toEqual([]);
  });

  it("preserves coverage while fading instanced levels that share a material", async () => {
    const material = new MeshBasicMaterial();
    const pair = () => {
      const mesh = new InstancedMesh(new BoxGeometry(2, 2, 2), material, 2);
      mesh.setMatrixAt(0, new Matrix4().makeTranslation(-1.5, 0, 0));
      mesh.setMatrixAt(1, new Matrix4().makeTranslation(1.5, 0, 0));
      return mesh;
    };
    const target = new Lod([{ object: pair() }, { object: pair() }]);
    const diameter = Math.hypot(5, 2, 2);
    const scene = new Scene().add(target);
    setMaxPixels(target, [40]);
    camera.position.set(0, 0, (diameter * 64) / (2 * tan * 40 * (1 - Lod.fade / 2)));
    camera.updateMatrixWorld();
    Lod.debug = true;
    await render(scene, camera);
    const pixels = await render(scene, camera);
    expect(visible(target)).toEqual([0, 1]);
    const coverage = (bytes: Uint8Array) => bytes.filter((_, i) => i % 4 === 3);
    target.forceLevel = 0;
    Lod.debug = false;
    expect(coverage(pixels)).toEqual(coverage(await render(scene, camera)));
    target.dispose();
  });

  it("clones rendered, hidden levels that switch on their own", () => {
    const target = lod();
    seenAt(target, 50);
    target.visible = false;
    const clone = target.clone();
    expect(clone.levels.map((level) => level.maxPixels)).toEqual([Infinity, 400, 100]);
    expect(visible(seenAt(clone, 1000))).toEqual([0]);
    expect(visible(target)).toEqual([2]);
  });
});

it.each([false, true])("fades in an installed source without popping (height fade: %s)", { timeout: GPU_TIMEOUT }, async (heightFade) => {
  const deferred = { load: async () => box(), maxPixels: Infinity, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) };
  const lod = new Lod([deferred, { object: box() }]);
  const coarse = lod.levels[1]?.object;
  if (!coarse) throw new Error("Missing coarse object");
  lod.forceLevel = heightFade ? null : 0;
  const coarseLevel = lod.levels[1];
  if (!coarseLevel) throw new Error("Missing coarse level");
  coarseLevel.maxPixels = 100;
  lod.position.z = heightFade ? -((DIAMETER * 64) / (2 * tan)) / 95 : -5;
  const eye = new PerspectiveCamera(60, 1, 0.1, 100);
  const scene = new Scene().add(lod);
  const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
  try {
    renderer.render(scene, eye);
    await nextLevel(lod, eye);
    const source = lod.levels[0]?.object;
    if (!source) throw new Error("Missing installed source");
    lod.update(eye);
    expect(fadeSourceOf(coarse)).toMatchObject({ fade: 0 });
    expect(source.visible).toBe(false);
    clock.mockReturnValue(1000 + ARRIVAL_MS / 2);
    lod.update(eye);
    expect(fadeSourceOf(source)).toMatchObject({ fade: 0.5 });
    expect(fadeSourceOf(coarse)).toMatchObject({ fade: -0.5 });
    expect(source.visible && coarse.visible).toBe(true);
    clock.mockReturnValue(1000 + ARRIVAL_MS);
    lod.update(eye);
    if (heightFade) {
      const sourceDraw = fadeSourceOf(source),
        coarseDraw = fadeSourceOf(coarse);
      expect(sourceDraw?.kind === "object" && sourceDraw.fade).toBeCloseTo(-0.5);
      expect(coarseDraw?.kind === "object" && coarseDraw.fade).toBeCloseTo(0.5);
    } else {
      expect(fadeSourceOf(source)).toMatchObject({ fade: 0 });
      expect(coarse.visible).toBe(false);
    }
  } finally {
    clock.mockRestore();
    lod.dispose();
  }
});

it("draws nothing, not even a given source, until its coarsest level has loaded, and each level at once once it has", { timeout: GPU_TIMEOUT }, async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const coarse = { load: async () => (await gate, box()), maxPixels: 5, box: new Box3().setFromArray([-1, -1, -1, 1, 1, 1]) };
  const lod = new Lod([{ object: box() }, coarse]);
  const scene = new Scene().add(lod);
  lod.position.z = -5;
  try {
    expect(() => lod.getLevel(camera)).toThrow(/render the Lod first/);
    await render(scene, camera);
    expect(visible(lod)).toEqual([]);
    expect(lod.getLevel(camera)).toBeNull();
    lod.position.z = -900;
    const arrived = nextLevel(lod, camera);
    release();
    await arrived;
    await render(scene, camera);
    expect(visible(lod)).toEqual([1]);
    expect(lod.getLevel(camera)).toBe(1);
    lod.position.z = -5;
    await render(scene, camera);
    expect(visible(lod)).toEqual([0]);
    expect(lod.getLevel(camera)).toBe(0);
  } finally {
    lod.dispose();
  }
});

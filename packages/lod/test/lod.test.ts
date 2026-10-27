import {
  BoxGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Raycaster,
  RenderTarget,
  Scene,
  Vector3,
  type Camera,
  type Material,
  type Object3D,
} from "three/webgpu";
import { afterEach, describe, expect, it } from "vitest";
import { drawOf } from "../src/fade.js";
import { Lod } from "../src/lod.js";
import { originalOf } from "../src/material.js";
import { TYPICAL_HEIGHT, viewportHeight } from "../src/view.js";
import { isMesh } from "../src/three.js";
import { GPU_TIMEOUT, render, renderer } from "./gpu.js";

const box = (material = new MeshBasicMaterial()) => new Mesh(new BoxGeometry(2, 2, 2), material);
/** Bounding diameter of `box()`: the box diagonal. */
const DIAMETER = 2 * Math.sqrt(3);
const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
const tan = Math.tan(Math.PI / 6);

/** A source and two levels used up to 400 and 100 px tall. */
function lod(): Lod {
  const result = new Lod([box(), box(), box()]);
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

/** Place `view` where the bounding sphere is `pixels` tall on a `height` px screen. */
function place(pixels: number, height = 1080, view: Camera = camera): void {
  view.position.set(0, 0, (DIAMETER * height) / (2 * tan * pixels));
  view.updateMatrixWorld();
}

/** Update `target` seen where it is `pixels` tall on the screen `view` last drew to. */
function viewAt(target: Lod, pixels: number, view: Camera = camera): Lod {
  place(pixels, viewportHeight(view) ?? TYPICAL_HEIGHT, view);
  target.updateMatrixWorld();
  target.update(view);
  return target;
}

const visible = (target: Lod) => target.levels.flatMap(({ object }, i) => (object.visible ? [i] : []));
const materialOf = (object: Object3D | undefined): Material => {
  const material = object && isMesh(object) ? [object.material].flat()[0] : undefined;
  if (!material) throw new Error("expected a mesh");
  return material;
};
/** The signed fade level `i` of `target` draws with (see fade.ts). */
const fadeOf = (target: Lod, i: number) => {
  const object = target.levels[i]?.object;
  const draw = object && drawOf(object);
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
    expect(visible(viewAt(target, 100.01))).toEqual([1]);
    expect(visible(viewAt(target, 99.99))).toEqual([1, 2]);
    camera.zoom = 2;
    camera.updateProjectionMatrix();
    // Twice as tall on screen: 50.01 px of the unzoomed view is above level 2's 100.
    expect(visible(viewAt(target, 50.01))).toEqual([1]);
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    expect(visible(viewAt(target, 140))).toEqual([1]);
    Lod.quality = 0.5;
    expect(visible(viewAt(target, 140))).toEqual([2]);
  });

  it("shows one level outside a fade and both neighbours inside it, splitting the pixels", () => {
    const target = lod();
    expect(visible(viewAt(target, 1000))).toEqual([0]);
    expect(visible(viewAt(target, 250))).toEqual([1]);
    expect(visible(viewAt(target, 50))).toEqual([2]);
    // The top Lod.fade of level 1's range, just under its maxPixels: half way through.
    expect(visible(viewAt(target, 400 * (1 - Lod.fade / 2)))).toEqual([0, 1]);
    expect(fadeOf(target, 1)).toBeCloseTo(0.5, 9);
    expect(fadeOf(target, 0)).toBeCloseTo(-0.5, 9);
    expect(fadeOf(target, 2)).toBe(0);
    expect(visible(viewAt(target, 100 * (1 - Lod.fade / 2)))).toEqual([1, 2]);
    expect(visible(viewAt(target, 250))).toEqual([1]);
    expect(fadeOf(target, 1)).toBe(0);
  });

  it("draws only forceLevel, without fades", () => {
    const target = lod();
    target.forceLevel = 2;
    expect(visible(viewAt(target, 400 * (1 - Lod.fade / 2)))).toEqual([2]);
    expect(fadeOf(target, 2)).toBe(0);
    target.forceLevel = 5;
    expect(() => viewAt(target, 250)).toThrow(/forceLevel 5/);
  });

  it("switches at once in an orthographic view", () => {
    const ortho = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    expect(visible(viewAt(lod(), 1, ortho))).toEqual([0]);
    // Inside level 1's fade, which an orthographic view skips.
    ortho.zoom = (400 * (1 - Lod.fade / 2) * 2) / (DIAMETER * 1080);
    ortho.updateProjectionMatrix();
    expect(visible(viewAt(lod(), 1, ortho))).toEqual([1]);
  });

  it("leaves a nested Lod's levels to it and hands over to it at once", () => {
    const inner = new Lod([box(), box()]);
    const outer = new Lod([box(), inner]);
    setMaxPixels(outer, [400]);
    viewAt(outer, 1000);
    expect([outer.levels[0]?.object.visible, inner.visible]).toEqual([true, false]);
    viewAt(outer, 400 * (1 - Lod.fade / 2));
    expect([outer.levels[0]?.object.visible, inner.visible]).toEqual([false, true]);
    expect(inner.levels.map(({ object }) => object.visible)).toEqual([true, true]);
  });

  it("refuses levels whose fades would overlap, and skinned meshes", () => {
    const target = lod();
    setMaxPixels(target, [100, 95]);
    expect(() => viewAt(target, 85)).toThrow(/level 2 has maxPixels 95, but at most 90/);
    const skinned = box();
    Object.assign(skinned, { isSkinnedMesh: true });
    expect(() => new Lod([skinned])).toThrow(/skinned/);
  });

  it("raycasts the source only", () => {
    const source = box();
    const level = box();
    level.position.x = 10;
    const target = new Lod([source, level]);
    target.updateMatrixWorld();
    const hits = new Raycaster(new Vector3(0.3, 0.2, 10), new Vector3(0, 0, -1)).intersectObject(target);
    expect(hits.map((hit) => hit.object)).toEqual([source]);
    expect(new Raycaster(new Vector3(10.3, 0.2, 10), new Vector3(0, 0, -1)).intersectObject(target)).toEqual([]);
  });

  it("is updated by the renderer and measures the target it renders into", async () => {
    const target = lod();
    const scene = new Scene().add(target);
    place(400 * (1 - Lod.fade / 2), 64);
    // The first frame tells the Lod the target's height.
    await render(scene, camera);
    await render(scene, camera);
    expect(visible(target)).toEqual([0, 1]);
    expect(fadeOf(target, 1)).toBeCloseTo(0.5, 6);
  });

  it("measures each camera at the height it renders at", () => {
    const target = lod();
    const scene = new Scene().add(target);
    const other = camera.clone();
    place(250, 64);
    other.position.copy(camera.position);
    other.updateMatrixWorld();
    const draw = (view: Camera, size: number) => {
      const into = new RenderTarget(size, size);
      renderer.setRenderTarget(into);
      renderer.render(scene, view);
      renderer.setRenderTarget(null);
      into.dispose();
    };
    draw(camera, 64);
    draw(other, 16);
    // 250 px on 64 px is level 1; the same view on 16 px is 62.5 px, level 2.
    draw(camera, 64);
    expect(visible(target)).toEqual([1]);
    draw(other, 16);
    expect(visible(target)).toEqual([2]);
  });

  it("measures the canvas in CSS pixels: the renderer's over its pixel ratio", () => {
    const target = lod();
    const scene = new Scene().add(target);
    place(150, 64);
    renderer.setPixelRatio(2);
    renderer.setSize(64, 64);
    try {
      renderer.render(scene, camera);
      renderer.render(scene, camera);
    } finally {
      renderer.setPixelRatio(1);
    }
    // 150 px of a 64 px canvas is level 1 (150 > 100): the 128 device pixels do not count.
    expect(visible(target)).toEqual([1]);
  });

  it("measures a target the canvas's size in CSS pixels too: post-processing draws into one", async () => {
    const scene = new Scene().add(lod());
    const view = new PerspectiveCamera();
    renderer.setPixelRatio(2);
    try {
      await render(scene, view, 128);
      expect(viewportHeight(view)).toBe(64);
      await render(scene, view, 96);
      expect(viewportHeight(view)).toBe(96);
    } finally {
      renderer.setPixelRatio(1);
    }
  });

  it("splits the pixels between both sides of a fade, though they share a material and are instanced", async () => {
    const material = new MeshBasicMaterial();
    const pair = () => {
      const mesh = new InstancedMesh(new BoxGeometry(2, 2, 2), material, 2);
      mesh.setMatrixAt(0, new Matrix4().makeTranslation(-1.5, 0, 0));
      mesh.setMatrixAt(1, new Matrix4().makeTranslation(1.5, 0, 0));
      return mesh;
    };
    const target = new Lod([pair(), pair()]);
    const diameter = Math.hypot(5, 2, 2);
    const scene = new Scene().add(target);
    setMaxPixels(target, [40]);
    camera.position.set(0, 0, (diameter * 64) / (2 * tan * 40 * (1 - Lod.fade / 2)));
    camera.updateMatrixWorld();
    Lod.debug = true;
    await render(scene, camera);
    const pixels = await render(scene, camera);
    expect(visible(target)).toEqual([0, 1]);
    // Debug tints: level 0 red-ish, level 1 green-ish; every covered pixel is one of them.
    let red = 0;
    let green = 0;
    let other = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const [r = 0, g = 0, b = 0] = pixels.subarray(i, i + 3);
      if (r === 0 && g === 0 && b === 0) continue;
      if (r > 200 && g < 150) red++;
      else if (g > 200 && r < 150) green++;
      else other++;
    }
    expect(other).toBe(0);
    expect(red).toBeGreaterThan((red + green) * 0.2);
    expect(green).toBeGreaterThan((red + green) * 0.2);
    target.forceLevel = 0;
    Lod.debug = false;
    const whole = (await render(scene, camera)).filter((v, i) => i % 4 === 0 && v > 0).length;
    expect(red + green).toBe(whole);
    expect(material.color.equals(new Color(1, 1, 1))).toBe(true);
  });

  it("clones after it rendered or while hidden, sharing its faded materials", () => {
    const target = lod();
    viewAt(target, 50);
    target.visible = false;
    const clone = target.clone();
    expect(clone.levels.map((level) => level.maxPixels)).toEqual([Infinity, 400, 100]);
    // One faded copy of a material for every Lod: they share its shader.
    expect(materialOf(clone.levels[0]?.object)).toBe(materialOf(target.levels[0]?.object));
    expect(originalOf(materialOf(clone.levels[0]?.object))).not.toBe(materialOf(clone.levels[0]?.object));
    expect(visible(viewAt(clone, 1000))).toEqual([0]);
    expect(visible(target)).toEqual([2]);
    expect(() => new Lod().copy(target).copy(target)).toThrow(/empty Lod/);
  });

  it("disposes every level once, and itself stops there", () => {
    const inner = new Lod([box(), box()]);
    const target = new Lod([box(), inner]);
    let materials = 0;
    let inners = 0;
    target.levels[0]?.object.traverse((node) => {
      if (isMesh(node)) originalOf([node.material].flat()[0] ?? new MeshBasicMaterial()).addEventListener("dispose", () => materials++);
    });
    const dispose = inner.dispose.bind(inner);
    inner.dispose = () => (inners++, dispose());
    target.dispose();
    expect([materials, inners]).toEqual([1, 1]);
  });
});

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
  Scene,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type Object3D,
} from "three";
import { afterEach, describe, expect, it } from "vitest";
import { fadeUniformsOf, originalOf } from "../src/fade.js";
import { Lod } from "../src/lod.js";
import { isMesh } from "../src/three.js";
import { GPU_TIMEOUT, renderer } from "./webgl.js";

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

/** Update `target` seen where it is `pixels` tall on a 1080 px screen. */
function viewAt(target: Lod, pixels: number, view: Camera = camera): Lod {
  place(pixels, 1080, view);
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

/** Renders `scene` into a 64 px target; RGBA bytes. */
function render(scene: Scene): Uint8Array {
  const target = new WebGLRenderTarget(64, 64);
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  const pixels = new Uint8Array(64 * 64 * 4);
  renderer.readRenderTargetPixels(target, 0, 0, 64, 64, pixels);
  renderer.setRenderTarget(null);
  target.dispose();
  return pixels;
}

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

  it("shows one level outside a fade and both neighbours inside it", () => {
    const target = lod();
    expect(visible(viewAt(target, 1000))).toEqual([0]);
    expect(visible(viewAt(target, 250))).toEqual([1]);
    expect(visible(viewAt(target, 50))).toEqual([2]);
    // The top Lod.fade of level 1's range, just under its maxPixels.
    expect(visible(viewAt(target, 400 * (1 - Lod.fade / 2)))).toEqual([0, 1]);
    expect(visible(viewAt(target, 100 * (1 - Lod.fade / 2)))).toEqual([1, 2]);
  });

  it("draws only forceLevel, without fades", () => {
    const target = lod();
    target.forceLevel = 2;
    expect(visible(viewAt(target, 400 * (1 - Lod.fade / 2)))).toEqual([2]);
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

  it("is updated by the renderer, measures its viewport and gives neighbours one fade", () => {
    const target = lod();
    const scene = new Scene().add(target);
    place(400 * (1 - Lod.fade / 2), 64);
    // The first frame tells the Lod the screen height.
    render(scene);
    render(scene);
    expect(visible(target)).toEqual([0, 1]);
    const fade = (i: number) => fadeUniformsOf(materialOf(target.levels[i]?.object))?.lodFade.value;
    const subtense = (pixels: number) => (pixels * 2 * tan) / 64;
    expect(fade(1)?.x).toBeCloseTo(subtense(400 * (1 - Lod.fade)), 9);
    expect(fade(1)?.y).toBeCloseTo(subtense(400), 9);
    expect(fade(0)?.toArray()).toEqual([0, 0, fade(1)?.x, fade(1)?.y]);
  });

  it("measures each camera at the height it renders at", () => {
    const target = lod();
    const scene = new Scene().add(target);
    const other = camera.clone();
    place(250, 64);
    other.position.copy(camera.position);
    other.updateMatrixWorld();
    const draw = (view: Camera, size: number) => {
      const into = new WebGLRenderTarget(size, size);
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

  it("splits the pixels between both sides of a fade, though they share a material and are instanced", () => {
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
    render(scene);
    const pixels = render(scene);
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
    const whole = render(scene).filter((v, i) => i % 4 === 0 && v > 0).length;
    expect(red + green).toBe(whole);
    expect(material.color.equals(new Color(1, 1, 1))).toBe(true);
  });

  it("clones after it rendered or while hidden, with its own faded copies", () => {
    const target = lod();
    viewAt(target, 50);
    target.visible = false;
    const clone = target.clone();
    expect(clone.levels.map((level) => level.maxPixels)).toEqual([Infinity, 400, 100]);
    expect(materialOf(clone.levels[0]?.object)).not.toBe(materialOf(target.levels[0]?.object));
    expect(originalOf(materialOf(clone.levels[0]?.object))).toBe(originalOf(materialOf(target.levels[0]?.object)));
    expect(visible(viewAt(clone, 1000))).toEqual([0]);
    expect(() => new Lod().copy(target).copy(target)).toThrow(/empty Lod/);
  });

  it("disposes every level once, and itself stops there", () => {
    const inner = new Lod([box(), box()]);
    const target = new Lod([box(), inner]);
    let materials = 0;
    let inners = 0;
    target.levels[0]?.object.traverse((node) => {
      if (isMesh(node)) [node.material].flat()[0]?.addEventListener("dispose", () => materials++);
    });
    const dispose = inner.dispose.bind(inner);
    inner.dispose = () => (inners++, dispose());
    target.dispose();
    expect([materials, inners]).toEqual([1, 1]);
  });
});

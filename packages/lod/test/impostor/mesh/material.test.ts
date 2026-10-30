import {
  AmbientLight,
  Box3,
  BoxGeometry,
  Color,
  DirectionalLight,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  StorageBufferAttribute,
} from "three/webgpu";
import { expect, it, vi } from "vitest";
import { drawOf, setDraw } from "../../../src/fade.js";
import { bakeImpostor } from "../../../src/impostor/bake/index.js";
import { ImpostorMesh, impostorInstances } from "../../../src/impostor/mesh/index.js";
import { InstancedLod } from "../../../src/instanced/index.js";
import { Lod } from "../../../src/lod.js";
import { GPU_TIMEOUT, render, renderer } from "../../gpu.js";

const at = (x: number, y: number, z = 0) => new Matrix4().makeTranslation(x, y, z);
const camera = () => {
  const camera = new OrthographicCamera(-5, 5, 5, -5, 0.1, 30);
  camera.position.set(0, 0, 15);
  camera.updateMatrixWorld();
  return camera;
};
const pixel = (pixels: Uint8Array, x: number, y: number) => {
  const offset = (Math.floor(((y + 5) / 10) * 64) * 64 + Math.floor(((x + 5) / 10) * 64)) * 4;
  return Array.from(pixels.slice(offset, offset + 4));
};
const color = (pixels: Uint8Array, x: number, y: number, expected: "white" | "red" | "green" | "blue" | "empty") => {
  const value = pixel(pixels, x, y);
  if (expected === "empty") {
    expect(value[3]).toBe(0);
    return;
  }
  expect(value[3]).toBeGreaterThan(200);
  for (let channel = 0; channel < 3; channel++) {
    if (expected === "white" || channel === ["red", "green", "blue"].indexOf(expected)) expect(value[channel]).toBeGreaterThan(60);
    else expect(value[channel]).toBeLessThan(10);
  }
};

it.each([false, true])("shares one impostor shader across crowd/single bindings (first draw colored: %s)", { timeout: GPU_TIMEOUT }, async (colored) => {
  const source = new Mesh(new BoxGeometry(1.5, 1.5, 1.5), new MeshStandardMaterial());
  const template = new ImpostorMesh(await bakeImpostor(source, { frames: 4, resolution: 16 }));
  const disposed = vi.fn();
  template.material.addEventListener("dispose", disposed);
  const left = new InstancedLod([{ object: template }], 2);
  const right = new InstancedLod([{ object: template }], 3);
  left.setMatrixAt(0, at(-2, 1));
  left.setMatrixAt(1, at(-2, -1));
  for (let index = 0; index < 3; index++) right.setMatrixAt(index, at(2, 2 - index * 2));
  if (colored) {
    left.setColorAt(0, new Color("red"));
    left.setColorAt(1, new Color("green"));
  } else for (let index = 0; index < 3; index++) right.setColorAt(index, new Color("blue"));
  const lod = new Lod([{ object: template }]);
  const single = lod.levels[0]?.object;
  if (!(single instanceof ImpostorMesh)) throw new Error("Missing single card");
  const scene = new Scene().add(left, right, lod, new AmbientLight(0xffffff, 3));
  const view = camera();
  const setup = vi.spyOn(template.material, "setup");
  const fades = new StorageBufferAttribute(new Float32Array([0, 1]), 1);
  try {
    let pixels = await render(scene, view);
    const first = left.children[0];
    if (!(first instanceof ImpostorMesh)) throw new Error("missing crowd card");
    expect(first.count).toBe(1);
    expect(left.count).toBe(2);
    expect(right.count).toBe(3);
    expect(template.count).toBe(1);
    expect(setup).toHaveBeenCalledOnce();
    expect(setup.mock.calls[0]?.[0].object).toBe(first);
    color(pixels, -2, 1, colored ? "red" : "white");
    color(pixels, 2, 0, colored ? "white" : "blue");
    color(pixels, 0, 0, "white");

    const version = template.material.version;
    left.setColorAt(0, new Color("red"));
    left.setColorAt(1, new Color(0, 1, 0));
    pixels = await render(scene, view);
    color(pixels, -2, 1, "red");
    color(pixels, -2, -1, "green");
    color(pixels, 2, 0, colored ? "white" : "blue");

    // copy replaces a previously bound matrix buffer; adding color replaces its
    // white fallback. Both changes must reach already-compiled bindings.
    const oldMatrix = single.instanceMatrix;
    template.setMatrixAt(0, at(0, -2));
    template.setColorAt(0, new Color(0, 1, 0));
    single.copy(template);
    expect(single.instanceMatrix).not.toBe(oldMatrix);
    pixels = await render(scene, view);
    color(pixels, 0, 0, "empty");
    color(pixels, 0, -2, "green");
    color(pixels, 2, 0, colored ? "white" : "blue");

    const draw = drawOf(first);
    if (draw?.kind !== "instances") throw new Error("missing crowd fade");
    setDraw(first, { ...draw, fades });
    pixels = await render(scene, view);
    color(pixels, -2, 1, "red");
    color(pixels, -2, -1, "empty");
    color(pixels, 0, -2, "green");
    expect(template.material.version).toBe(version);
    expect(setup).toHaveBeenCalledOnce();
  } finally {
    setup.mockRestore();
    left.dispose();
    right.dispose();
    lod.dispose();
    expect(disposed).toHaveBeenCalledOnce();
    fades.dispose();
    source.geometry.dispose();
    source.material.dispose();
  }
});

it("shares shadow shader builds while each crowd and single card keeps its own matrix and fade buffers", { timeout: GPU_TIMEOUT }, async () => {
  const source = new Mesh(new BoxGeometry(1.5, 1.5, 1.5), new MeshStandardMaterial());
  const template = new ImpostorMesh(await bakeImpostor(source, { frames: 4, resolution: 16 }));
  template.castShadow = true;
  const left = new InstancedLod([{ object: template }], 2);
  const right = new InstancedLod([{ object: template }], 3);
  left.setMatrixAt(0, at(-3, 0));
  left.setMatrixAt(1, at(-3, 0, 2));
  for (let index = 0; index < 3; index++) right.setMatrixAt(index, at(3, 0, 2 - index * 2));
  const lod = new Lod([{ object: template.clone() }]);
  for (const root of [left, right, lod])
    root.traverse((object) => {
      if (object instanceof Mesh) object.layers.set(1);
    });
  const ground = new Mesh(new PlaneGeometry(20, 20).rotateX(-Math.PI / 2), new MeshStandardMaterial());
  ground.position.y = -2;
  ground.receiveShadow = true;
  const sun = new DirectionalLight(0xffffff, 3);
  sun.position.set(0, 20, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(128, 128);
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 0.1, far: 40 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.camera.layers.enable(1);
  const view = camera();
  view.position.set(0, 20, 0);
  view.up.set(0, 0, -1);
  view.lookAt(0, 0, 0);
  const scene = new Scene().add(left, right, lod, ground, sun, sun.target, new AmbientLight(0xffffff, 0.2));
  const shadow = vi.spyOn(NodeMaterial.prototype, "setup");
  const builds = () => shadow.mock.calls.filter(([builder]) => builder.material.name === "ShadowMaterial" && builder.object instanceof ImpostorMesh);
  const fades = new StorageBufferAttribute(new Float32Array([1, 0]), 1);
  const enabled = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = true;
  try {
    let pixels = await render(scene, view);
    const lit = pixel(pixels, 0, 4)[0] ?? 0;
    for (const x of [-3, 0, 3]) expect(pixel(pixels, x, 0)[0]).toBeLessThan(lit * 0.7);
    expect(builds()).toHaveLength(1);
    const first = left.children[0];
    if (!first) throw new Error("missing crowd card");
    const draw = drawOf(first);
    if (draw?.kind !== "instances") throw new Error("missing crowd fade");
    setDraw(first, { ...draw, fades });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    pixels = await render(scene, view);
    expect(pixel(pixels, -3, 0)[0]).toBeGreaterThan(lit * 0.9);
    expect(pixel(pixels, -3, -2)[0]).toBeLessThan(lit * 0.7);
    expect(pixel(pixels, 3, 0)[0]).toBeLessThan(lit * 0.7);
    expect(pixel(pixels, 0, 0)[0]).toBeLessThan(lit * 0.7);
    expect(builds()).toHaveLength(1);
  } finally {
    shadow.mockRestore();
    renderer.shadowMap.enabled = enabled;
    left.dispose();
    right.dispose();
    lod.dispose();
    fades.dispose();
    ground.geometry.dispose();
    ground.material.dispose();
    source.geometry.dispose();
    source.material.dispose();
    sun.dispose();
  }
});

it("keeps shared shading's placements and colours separate in direct light", { timeout: GPU_TIMEOUT }, async () => {
  const source = new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial());
  const impostor = await bakeImpostor(source, { frames: 4, resolution: 16 });
  const template = new ImpostorMesh(impostor);
  const white = impostorInstances(template, 1, at(-2, -2));
  const red = impostorInstances(template, 1, at(2, -2));
  expect(white.material).toBe(red.material);
  red.setColorAt(0, new Color(1, 0, 0));
  // Two instances build a shader of their own, with colours.
  const pair = new ImpostorMesh(impostor, 2);
  pair.setMatrixAt(0, new Matrix4().makeTranslation(-2, 2, 0));
  pair.setMatrixAt(1, new Matrix4().makeTranslation(2, 2, 0));
  pair.setColorAt(0, new Color(1, 1, 1));
  pair.setColorAt(1, new Color(1, 0, 0));
  pair.computeBoundingSphere();
  const camera = new OrthographicCamera(-4, 4, 4, -4, 0.1, 20);
  camera.position.set(0, 0, 10);
  const pixels = await render(new Scene().add(white, red, pair, new AmbientLight(0xffffff, 1), new DirectionalLight(0xffffff, 3)), camera);
  // Rows bottom-up: a quarter in from either side, a quarter from the bottom or top.
  const rgb = (x: number, y: number) => Array.from(pixels.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 3));
  for (const y of [16, 48]) {
    const [left, right] = [rgb(16, y), rgb(48, y)];
    expect(left[1]).toBeGreaterThan(60);
    expect(right[0]).toBeGreaterThan(60);
    expect(right[1]).toBeLessThan(10);
  }
  pair.dispose();
  white.dispose();
  red.dispose();
  template.dispose();
  source.geometry.dispose();
  source.material.dispose();
});

it("keeps shared crowds' compiled main and shadow bindings valid when a deferred level installs", { timeout: GPU_TIMEOUT }, async () => {
  const template = new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial());
  template.castShadow = true;
  const data = await bakeImpostor(template, { frames: 4, resolution: 16 });
  const disposed = vi.fn();
  const deferred = {
    load: async () => {
      const card = new ImpostorMesh(data);
      card.castShadow = true;
      card.material.addEventListener("dispose", disposed);
      return card;
    },
    maxPixels: 100,
    box: new Box3().setFromArray(data.box),
  };
  const a = new InstancedLod([{ object: template }, deferred], 1),
    b = new InstancedLod([{ object: template }, deferred], 1);
  a.setMatrixAt(0, new Matrix4().makeScale(3, 3, 3).setPosition(-6, 0, 2));
  b.setMatrixAt(0, new Matrix4().makeScale(3, 3, 3).setPosition(6, 0, 2));
  a.forceLevel = b.forceLevel = 0;
  const ground = new Mesh(new PlaneGeometry(32, 32).rotateX(-Math.PI / 2), new MeshStandardMaterial({ color: 0xffffff, roughness: 1 }));
  ground.position.y = -4;
  ground.receiveShadow = true;
  const sun = new DirectionalLight(0xffffff, 3);
  sun.position.set(0, 20, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(64, 64);
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 0, far: 40 });
  sun.shadow.camera.updateProjectionMatrix();
  const scene = new Scene().add(a, b, ground, sun, sun.target, new AmbientLight(0xffffff, 0.2));
  const camera = new OrthographicCamera(-16, 16, 16, -16, 0.1, 100);
  camera.position.set(0, 20, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  renderer.shadowMap.enabled = true;
  try {
    const before = await render(scene, camera);
    expect(a.levels[1]?.object).toBeUndefined();
    a.forceLevel = b.forceLevel = 1;
    await vi.waitFor(
      () => {
        renderer.render(scene, camera);
        expect(a.children).toHaveLength(2);
        expect(b.children).toHaveLength(2);
      },
      { timeout: GPU_TIMEOUT },
    );
    a.forceLevel = b.forceLevel = 0;
    // Shadow nodes update once per animation frame; discard the last forced
    // coarse shadow before comparing the original source view.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const after = await render(scene, camera);
    expect(a.children).toHaveLength(2);
    expect(b.children).toHaveLength(2);
    expect(after).toEqual(before);
    a.forceLevel = b.forceLevel = 1;
    const cards = await render(scene, camera);
    expect(cards.some((value) => value > 0)).toBe(true);
  } finally {
    a.dispose();
    b.dispose();
    expect(disposed).toHaveBeenCalledOnce();
    ground.geometry.dispose();
    ground.material.dispose();
    sun.dispose();
  }
});

it("shares programs across baked specular values while keeping each asset's colour", { timeout: GPU_TIMEOUT }, async () => {
  const source = new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial({ color: 0x000000, roughness: 0.5 }));
  const impostor = await bakeImpostor(source, { frames: 4, resolution: 16 });
  const left = new ImpostorMesh(impostor);
  const right = new ImpostorMesh({ ...impostor, specular: [0.8, 0.02, 0.02, 0.5] });
  left.position.x = -2;
  right.position.x = 2;
  const light = new DirectionalLight(0xffffff, 1);
  light.position.set(0, 0, 10);
  const scene = new Scene().add(left, light);
  const view = camera();
  try {
    await render(scene, view);
    const programs = renderer.info.memory.programs;
    scene.add(right);
    const pixels = await render(scene, view);
    expect(renderer.info.memory.programs).toBe(programs);
    const neutral = pixel(pixels, -2, 0);
    const red = pixel(pixels, 2, 0);
    expect(red[0]).toBeGreaterThan(neutral[0] ?? 0);
    expect(red[0]).toBeGreaterThan((red[1] ?? 0) * 2);
    expect(neutral[0]).toEqual(neutral[1]);
  } finally {
    left.dispose();
    right.dispose();
    source.geometry.dispose();
    source.material.dispose();
  }
});

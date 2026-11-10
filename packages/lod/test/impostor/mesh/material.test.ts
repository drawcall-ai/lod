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
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  StorageBufferAttribute,
  type Camera,
  type Material,
} from "three/webgpu";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
import { expect, it, vi } from "vitest";
import { fadeSourceOf, setFadeSource, type InstanceSlots } from "../../../src/levels/fade.js";
import type { InstancedLod } from "../../../src/instanced/index.js";
import { bakeImpostor } from "../../../src/impostor/bake/index.js";
import { ImpostorMesh, impostorInstances } from "../../../src/impostor/mesh/index.js";
import { Lod } from "../../../src/lod.js";
import { GPU_TIMEOUT, bakeRenderer, render, renderer, eventually, gpu } from "../../renderer.js";
import { chunkOf, oneChunk } from "../../instances.js";
import { must } from "../../must.js";

const at = (x: number, y: number, z = 0) => new Matrix4().makeTranslation(x, y, z);
const camera = () => {
  const camera = new OrthographicCamera(-5, 5, 5, -5, 0.1, 30);
  camera.position.set(0, 0, 15);
  camera.updateMatrixWorld();
  return camera;
};
/**
 * Slots for `lod`'s card in which every slot of every camera's lists draws instance `only` of its chunk, unfaded, the
 * card's own draws read from `drawn`: what a draw reads as bindings it has not drawn with.
 */
async function drawingOnly(
  lod: InstancedLod,
  camera: Camera,
  only: number,
  drawn: (camera: Camera) => InstanceSlots,
): Promise<(camera: Camera) => InstanceSlots> {
  const card = must(lod.children[0]);
  if (!(card instanceof ImpostorMesh)) throw new Error("not a card");
  const real = drawn(camera);
  const listed = new Uint32Array(await renderer.getArrayBufferAsync(real.indices));
  const matrices = new Float32Array(await renderer.getArrayBufferAsync(card.instanceMatrix));
  const { elements } = chunkOf(lod).getMatrixAt(only, new Matrix4());
  const index = listed.find((i) => [12, 13, 14].every((e) => matrices[i * 16 + e] === elements[e]));
  if (index === undefined) throw new Error(`instance ${only} is not listed`);
  const indices = new StorageBufferAttribute(new Uint32Array(listed.length).fill(index), 1);
  const fades = new StorageBufferAttribute(new Float32Array(listed.length), 1);
  return (other) => ({ indices, fades, args: drawn(other).args });
}

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

it.each([false, true])(
  "shares one impostor shader across InstancedLod and single bindings (first draw colored: %s)",
  { timeout: GPU_TIMEOUT },
  async (colored) => {
    const source = new Mesh(new BoxGeometry(1.5, 1.5, 1.5), new MeshStandardMaterial());
    const template = new ImpostorMesh(await bakeImpostor(source, bakeRenderer, { frames: 4, resolution: 16 }));
    const disposed = vi.fn();
    template.material.addEventListener("dispose", disposed);
    const left = oneChunk([{ object: template }], [at(-2, 1), at(-2, -1)], {
      colors: colored ? [new Color("red"), new Color("green")] : [new Color("white"), new Color("white")],
    });
    const right = oneChunk(
      [{ object: template }],
      [0, 1, 2].map((index) => at(2, 2 - index * 2)),
      { colors: colored ? undefined : [0, 1, 2].map(() => new Color("blue")) },
    );
    const lod = new Lod([{ object: template }], gpu);
    const single = lod.levels[0]?.object;
    if (!(single instanceof ImpostorMesh)) throw new Error("Missing single card");
    const scene = new Scene().add(left, right, lod, new AmbientLight(0xffffff, 3));
    const eye = camera();
    const setup = vi.spyOn(template.material, "setup");
    try {
      let pixels = await render(scene, eye);
      const first = left.children[0];
      if (!(first instanceof ImpostorMesh)) throw new Error("missing InstancedLod card");
      expect(first.count).toBe(1);
      expect(template.count).toBe(1);
      expect(setup).toHaveBeenCalledOnce();
      expect(setup.mock.calls[0]?.[0].object).toBe(first);
      color(pixels, -2, 1, colored ? "red" : "white");
      color(pixels, 2, 0, colored ? "white" : "blue");
      color(pixels, 0, 0, "white");

      const version = template.material.version;
      const chunk = chunkOf(left);
      chunk.setColorAt(0, new Color("red"));
      chunk.setColorAt(1, new Color(0, 1, 0));
      if (chunk.instanceColor) chunk.instanceColor.needsUpdate = true;
      pixels = await render(scene, eye);
      color(pixels, -2, 1, "red");
      color(pixels, -2, -1, "green");
      color(pixels, 2, 0, colored ? "white" : "blue");

      // copy replaces a previously bound matrix buffer; adding color replaces its
      // a white default. Both changes must reach already-compiled bindings.
      const oldMatrix = single.instanceMatrix;
      template.setMatrixAt(0, at(0, -2));
      template.setColorAt(0, new Color(0, 1, 0));
      single.copy(template);
      expect(single.instanceMatrix).not.toBe(oldMatrix);
      pixels = await render(scene, eye);
      color(pixels, 0, 0, "empty");
      color(pixels, 0, -2, "green");
      color(pixels, 2, 0, colored ? "white" : "blue");

      const draw = fadeSourceOf(first);
      if (draw?.kind !== "instances") throw new Error("missing InstancedLod fade");
      if (!draw.slots) throw new Error("missing InstancedLod slots");
      // Instance 1 hidden: every slot draws instance 0.
      setFadeSource(first, { ...draw, slots: await drawingOnly(left, eye, 0, draw.slots) });
      pixels = await render(scene, eye);
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
      // The template is the caller's: the Lods free only their copies.
      expect(disposed).not.toHaveBeenCalled();
      template.dispose();
      expect(disposed).toHaveBeenCalledOnce();
      source.geometry.dispose();
      source.material.dispose();
    }
  },
);

it("shares shadow shader builds while each InstancedLod and single card holds its own matrix and fade buffers", { timeout: GPU_TIMEOUT }, async () => {
  const source = new Mesh(new BoxGeometry(1.5, 1.5, 1.5), new MeshStandardMaterial());
  const template = new ImpostorMesh(await bakeImpostor(source, bakeRenderer, { frames: 4, resolution: 16 }));
  template.castShadow = true;
  const left = oneChunk([{ object: template }], [at(-3, 0), at(-3, 0, 2)]);
  const right = oneChunk(
    [{ object: template }],
    [0, 1, 2].map((index) => at(3, 0, 2 - index * 2)),
  );
  const lod = new Lod([{ object: template.clone() }], gpu);
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
  const eye = camera();
  eye.position.set(0, 20, 0);
  eye.up.set(0, 0, -1);
  eye.lookAt(0, 0, 0);
  const scene = new Scene().add(left, right, lod, ground, sun, sun.target, new AmbientLight(0xffffff, 0.2));
  const shadow = vi.spyOn(NodeMaterial.prototype, "setup");
  // The shadow maps' own builds: compileAsync prepares a level's draws with copies of the shadow material (see compile/).
  const copy = (material: Material) => Object.getOwnPropertyDescriptor(material, "side")?.get !== undefined;
  const builds = () =>
    shadow.mock.calls.filter(([builder]) => builder.material.name === "ShadowMaterial" && !copy(builder.material) && builder.object instanceof ImpostorMesh);
  const enabled = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = true;
  try {
    let pixels = await render(scene, eye);
    const lit = pixel(pixels, 0, 4)[0] ?? 0;
    for (const x of [-3, 0, 3]) expect(pixel(pixels, x, 0)[0]).toBeLessThan(lit * 0.7);
    expect(builds()).toHaveLength(1);
    const first = left.children[0];
    if (!first) throw new Error("missing InstancedLod card");
    const draw = fadeSourceOf(first);
    if (draw?.kind !== "instances") throw new Error("missing InstancedLod fade");
    if (!draw.slots) throw new Error("missing InstancedLod slots");
    // Instance 0 hidden: every slot draws instance 1.
    setFadeSource(first, { ...draw, slots: await drawingOnly(left, sun.shadow.camera, 1, draw.slots) });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    pixels = await render(scene, eye);
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
    ground.geometry.dispose();
    ground.material.dispose();
    source.geometry.dispose();
    source.material.dispose();
    sun.dispose();
  }
});

it("holds shared shading's placements and colours separate in direct light", { timeout: GPU_TIMEOUT }, async () => {
  const source = new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial());
  const impostor = await bakeImpostor(source, bakeRenderer, { frames: 4, resolution: 16 });
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

it("holds shared InstancedLods' compiled main and shadow bindings valid when a deferred level installs", { timeout: GPU_TIMEOUT }, async () => {
  const template = new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial());
  template.castShadow = true;
  const data = await bakeImpostor(template, bakeRenderer, { frames: 4, resolution: 16 });
  const disposed = vi.fn();
  const card = new ImpostorMesh(data);
  card.castShadow = true;
  card.material.addEventListener("dispose", disposed);
  // Memoized, as a load shared across Lods is to share one object, and the caller's to free once both let go.
  const made = Promise.resolve(card);
  let holders = 0;
  const deferred = {
    hold: () => {
      holders++;
      return () => void holders--;
    },
    load: () => made,
    maxPixels: 100,
    box: new Box3().setFromArray(data.box),
  };
  // A given coarsest level draws from the start, so the source draws before the deferred level installs.
  const coarsest = { object: new Mesh(new BoxGeometry(2, 2, 2), template.material), maxPixels: 10 };
  const a = oneChunk([{ object: template }, deferred, coarsest], [new Matrix4().makeScale(3, 3, 3).setPosition(-6, 0, 2)]),
    b = oneChunk([{ object: template }, deferred, coarsest], [new Matrix4().makeScale(3, 3, 3).setPosition(6, 0, 2)]);
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
    await eventually(() => {
      renderer.render(scene, camera);
      expect(a.children).toHaveLength(3);
      expect(b.children).toHaveLength(3);
    });
    a.forceLevel = b.forceLevel = 0;
    // Shadow nodes update once per animation frame; discard the last forced
    // coarse shadow before comparing the source's picture.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const after = await render(scene, camera);
    expect(a.children).toHaveLength(3);
    expect(b.children).toHaveLength(3);
    expect(after).toEqual(before);
    a.forceLevel = b.forceLevel = 1;
    const cards = await render(scene, camera);
    expect(cards.some((value) => value > 0)).toBe(true);
  } finally {
    a.dispose();
    b.dispose();
    // Let go once the compiles the renders started have finished with the card.
    await eventually(() => expect(holders).toBe(0));
    expect(disposed).not.toHaveBeenCalled();
    card.dispose();
    expect(disposed).toHaveBeenCalledOnce();
    ground.geometry.dispose();
    ground.material.dispose();
    sun.dispose();
  }
});

it("shares programs across baked specular values, each asset lit in its own colour", { timeout: GPU_TIMEOUT }, async () => {
  const source = new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial({ color: 0x000000, roughness: 0.5 }));
  const impostor = await bakeImpostor(source, bakeRenderer, { frames: 4, resolution: 16 });
  const left = new ImpostorMesh(impostor);
  const right = new ImpostorMesh({ ...impostor, specular: [0.8, 0.02, 0.02, 0.5] });
  left.position.x = -2;
  right.position.x = 2;
  const light = new DirectionalLight(0xffffff, 1);
  light.position.set(0, 0, 10);
  const scene = new Scene().add(left, light);
  const eye = camera();
  try {
    await render(scene, eye);
    const programs = renderer.info.memory.programs;
    scene.add(right);
    const pixels = await render(scene, eye);
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

it.each([false, true])("draws an impostor lit by a shadow-casting directional light (cascaded: %s)", { timeout: GPU_TIMEOUT }, async (cascaded) => {
  const source = new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial());
  const impostor = new ImpostorMesh(await bakeImpostor(source, bakeRenderer, { frames: 4, resolution: 16 }));
  impostor.castShadow = true;
  impostor.receiveShadow = true;
  const sun = new DirectionalLight(0xffffff, 3);
  sun.position.set(2, 6, 4);
  sun.castShadow = true;
  if (cascaded) sun.shadow.shadowNode = new CSMShadowNode(sun, { cascades: 2, maxFar: 40 });
  const camera = new PerspectiveCamera(40, 1, 0.1, 50);
  camera.position.set(0, 0, 8);
  camera.updateMatrixWorld();
  renderer.shadowMap.enabled = true;
  try {
    const pixels = await render(new Scene().add(impostor, sun, new AmbientLight(0xffffff, 0.5)), camera);
    // The middle of the picture, where the box stands.
    expect(pixels[(32 * 64 + 32) * 4 + 3]).toBeGreaterThan(200);
  } finally {
    renderer.shadowMap.enabled = false;
    impostor.dispose();
    sun.dispose();
    source.geometry.dispose();
    source.material.dispose();
  }
});

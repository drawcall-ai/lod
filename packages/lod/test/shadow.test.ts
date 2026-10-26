import { BoxGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, Scene, WebGLRenderTarget, type Camera } from "three";
import { describe, expect, it } from "vitest";
import type { Impostor } from "../src/impostor/impostor.js";
import { ImpostorMesh } from "../src/impostor/mesh/index.js";
import { InstancedLod } from "../src/instanced/index.js";
import { Lod } from "../src/lod.js";
import { isInstancedMesh, isMesh } from "../src/three.js";
import { must } from "./must.js";
import { renderer } from "./webgl.js";
import { Wind } from "../src/wind/index.js";

/** A 2 × 2 × 2 box: about 3.5 across its bounding sphere. */
const box = () => new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());

const impostor = (): Impostor => ({
  version: 3,
  layout: "full",
  frames: 4,
  size: 16,
  box: [-1, -1, -1, 1, 1, 1],
  halfSize: 1.5,
  maps: ["base", "normalDepth", "orm"],
  layers: [0, 1, 2].map(() => [16, 8, 4].map((size) => new Uint8Array(size * size * 4))),
});

const map = new WebGLRenderTarget(100, 100);
const scene = new Scene();
// three's types ask for an Object3D Group where the renderer passes a geometry group; the hooks ignore it.
const group = new Group();

/** What `mesh` draws (instances, or vertices) into a 100-texel map of `shadowCamera`; it is as before afterwards. */
function drawnInto(mesh: Mesh, shadowCamera: Camera): number {
  const camera = new PerspectiveCamera();
  const material = new MeshBasicMaterial();
  const count = () => (isInstancedMesh(mesh) ? mesh.count : mesh.geometry.drawRange.count);
  const before = count();
  renderer.setRenderTarget(map);
  mesh.onBeforeShadow(renderer, scene, camera, shadowCamera, mesh.geometry, material, group);
  const drawn = count();
  mesh.onAfterShadow(renderer, scene, camera, shadowCamera, mesh.geometry, material, group);
  renderer.setRenderTarget(null);
  expect(count()).toBe(before);
  return drawn;
}

/** A directional light's camera over `width` world units: texels `width / 100` wide. */
const sun = (width: number) => new OrthographicCamera(-width / 2, width / 2, width / 2, -width / 2);

describe("casters smaller than a shadow texel", () => {
  it("draw nothing into that map: a Lod's meshes, by the whole object", () => {
    const source = box();
    const lod = new Lod([source]);
    lod.scale.setScalar(2);
    lod.updateMatrixWorld();
    expect(drawnInto(source, sun(100))).toBe(Infinity);
    // 7 units across under the Lod's scale: still wider than a 5-unit texel, not a 10-unit one.
    expect(drawnInto(source, sun(500))).toBe(Infinity);
    expect(drawnInto(source, sun(1000))).toBe(0);
    // Spot and point lights are not checked.
    expect(drawnInto(source, new PerspectiveCamera(170))).toBe(Infinity);
  });

  it("draw nothing into that map: an InstancedLod's levels, by their largest instance", () => {
    const lod = new InstancedLod([box()], 2);
    lod.setMatrixAt(1, new Matrix4().makeScale(3, 3, 3).setPosition(50, 0, 0));
    lod.updateMatrixWorld();
    lod.update(new PerspectiveCamera());
    const [mesh] = lod.children.filter(isMesh);
    expect(drawnInto(must(mesh), sun(800))).toBe(2);
    expect(drawnInto(must(mesh), sun(1200))).toBe(0);
  });

  it("draw nothing into that map: an ImpostorMesh, by its largest instance", () => {
    const mesh = new ImpostorMesh(impostor(), 2);
    mesh.setMatrixAt(1, new Matrix4().makeScale(3, 3, 3));
    mesh.updateMatrixWorld();
    expect(drawnInto(mesh, sun(800))).toBe(2);
    expect(drawnInto(mesh, sun(1200))).toBe(0);
    mesh.dispose();
  });

  it("keeps a wind impostor's shadow until its whole sway envelope is subtexel", () => {
    const mesh = new ImpostorMesh(impostor());
    mesh.updateMatrixWorld();
    // The resting diameter is 3.46 units; sway adds two units on either side.
    expect(drawnInto(mesh, sun(500))).toBe(0);
    new Wind().apply(mesh, { amplitude: 2 });
    expect(drawnInto(mesh, sun(500))).toBe(1);
    expect(drawnInto(mesh, sun(800))).toBe(0);
    mesh.dispose();
  });
});

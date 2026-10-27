import { AmbientLight, BoxGeometry, DirectionalLight, Group, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, OrthographicCamera, PlaneGeometry, Scene, type Object3D } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { bakeImpostor } from "../src/impostor/bake/index.js";
import { ImpostorMesh } from "../src/impostor/mesh/index.js";
import { InstancedLod } from "../src/instanced/index.js";
import { Lod } from "../src/lod.js";
import { isMesh } from "../src/three.js";
import { Wind } from "../src/wind/index.js";
import { GPU_TIMEOUT, render, renderer } from "./gpu.js";

// Casters narrower than a texel of a directional light's shadow map draw nothing into
// it. Here the light shines straight down onto a ground the camera sees from above, and
// the casters' meshes are on a layer only the light sees (the LOD itself stays on the
// camera's, which updates it): the ground under a caster is dark where its shadow falls,
// lit where it does not.

/** A 2 × 2 × 2 box: about 3.5 across its bounding sphere. */
const box = () => new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());

/** Light layers only: the camera sees the ground. */
const CASTERS = 1;

/**
 * Centres of shadow texels: the map is 64 texels across 256 units, texels 4 units wide,
 * from -128. A caster there covers a texel centre whatever its size, so only the rule
 * keeps a small one out of the map.
 */
const SMALL = { x: -6, z: 2 };
const LARGE = { x: 6, z: 2 };

/**
 * How dark the ground is (0..1 of fully lit) under `object` at each of `points`, seen
 * from above in a 16-unit square around the origin.
 */
async function shadowAt(object: Object3D, ...points: Array<{ x: number; z: number }>): Promise<number[]> {
  renderer.shadowMap.enabled = true;
  const scene = new Scene();
  const ground = new Mesh(new PlaneGeometry(32, 32).rotateX(-Math.PI / 2), new MeshStandardMaterial({ color: 0xffffff, roughness: 1 }));
  ground.position.y = -4;
  ground.receiveShadow = true;
  const sun = new DirectionalLight(0xffffff, 3);
  sun.position.set(0, 20, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(64, 64);
  Object.assign(sun.shadow.camera, { left: -128, right: 128, top: 128, bottom: -128, near: 0, far: 40 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.camera.layers.enable(CASTERS);
  object.traverse((node) => {
    if (!isMesh(node)) return;
    node.layers.set(CASTERS);
    node.castShadow = true;
  });
  scene.add(ground, sun, sun.target, new AmbientLight(0xffffff, 0.2), object);
  // A camera of its own every time: three renders a shadow map once a frame per camera.
  // Screen up is -z, so x runs left to right and z top to bottom.
  const camera = new OrthographicCamera(-8, 8, 8, -8, 0.1, 100);
  camera.position.set(0, 20, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  scene.updateMatrixWorld();
  const pixels = await render(scene, camera, 64);
  // Rows run bottom-up: the bottom row is z = 8.
  const red = (x: number, z: number) => pixels[(Math.round(((8 - z) / 16) * 63) * 64 + Math.round(((x + 8) / 16) * 63)) * 4] ?? 0;
  const lit = red(0, -7);
  return points.map(({ x, z }) => 1 - red(x, z) / lit);
}

/** `object` placed at `at`, scaled by `scale`. */
function placed<T extends Object3D>(object: T, at: { x: number; z: number }, scale = 1): T {
  object.position.set(at.x, 0, at.z);
  object.scale.setScalar(scale);
  return object;
}

const at = (point: { x: number; z: number }, scale = 1) => new Matrix4().makeScale(scale, scale, scale).setPosition(point.x, 0, point.z);

describe("casters smaller than a shadow texel", { timeout: GPU_TIMEOUT }, () => {
  it("cast nothing: a Lod's meshes, by the whole object", async () => {
    // 3.5 units across its bounding sphere, narrower than a texel; 3× that, wider.
    const lods = new Group().add(placed(new Lod([box()]), SMALL), placed(new Lod([box()]), LARGE, 3));
    const [small, large] = await shadowAt(lods, SMALL, LARGE);
    expect(small).toBeLessThan(0.1);
    expect(large).toBeGreaterThan(0.15);
  });

  it("cast nothing: an InstancedLod's instances, each by its own size", async () => {
    const lod = new InstancedLod([box()], 2);
    lod.setMatrixAt(0, at(SMALL));
    lod.setMatrixAt(1, at(LARGE, 3));
    const [small, large] = await shadowAt(lod, SMALL, LARGE);
    expect(small).toBeLessThan(0.1);
    expect(large).toBeGreaterThan(0.15);
  });

  it("cast nothing: an ImpostorMesh's instances, each by its own size, the wind's sway included", async () => {
    const impostor = await bakeImpostor(box(), { frames: 4, resolution: 16 });
    const mesh = new ImpostorMesh(impostor, 2);
    mesh.setMatrixAt(0, at(SMALL));
    // Many texels wide: an impostor minified to about a texel dithers its coverage.
    mesh.setMatrixAt(1, at(LARGE, 8));
    mesh.computeBoundingSphere();
    const [small, large] = await shadowAt(mesh, SMALL, LARGE);
    expect(small).toBeLessThan(0.1);
    expect(large).toBeGreaterThan(0.15);
    // The sway envelope widens the smaller one past a texel.
    new Wind().apply(mesh, { amplitude: 1 });
    expect((await shadowAt(mesh, SMALL))[0]).toBeGreaterThan(0.15);
    mesh.dispose();
  });
});

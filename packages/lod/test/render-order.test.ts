import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Scene } from "three/webgpu";
import { expect, it } from "vitest";
import { render, renderer } from "./renderer.js";

it("draws opaque surfaces before cutouts at the same order and honors explicit ordering", () => {
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const early = new Group();
  early.renderOrder = -1;
  scene.add(early);

  const geometry = new BoxGeometry();
  const solid = new MeshBasicMaterial();
  const cutout = new MeshBasicMaterial({ alphaTest: 0.5 });
  const coverage = new MeshBasicMaterial({ alphaToCoverage: true });
  const transparent = new MeshBasicMaterial({ transparent: true });
  const drawn: string[] = [];
  function add(name: string, material: MeshBasicMaterial, z: number, order = 0, parent: Scene | Group = scene) {
    const mesh = new Mesh(geometry, material);
    mesh.position.z = z;
    mesh.renderOrder = order;
    mesh.onBeforeRender = () => drawn.push(name);
    parent.add(mesh);
  }

  add("cutout", cutout, -3);
  add("coverage", coverage, -4);
  add("far solid", solid, -9);
  add("near solid", solid, -6);
  add("early mesh", cutout, -10, -1);
  add("early group", coverage, -12, 1, early);
  add("near transparent", transparent, -2);
  add("far transparent", transparent, -7);
  try {
    renderer.render(scene, camera);
    expect(drawn).toEqual(["early group", "early mesh", "near solid", "far solid", "cutout", "coverage", "far transparent", "near transparent"]);
  } finally {
    geometry.dispose();
    for (const material of [solid, cutout, coverage, transparent]) material.dispose();
  }
});

it("lets explicit renderOrder choose the visible surface of coplanar meshes", async () => {
  const geometry = new PlaneGeometry(2, 2);
  const cutout = new Mesh(geometry, new MeshBasicMaterial({ color: 0xff0000, alphaTest: 0.5 }));
  const solid = new Mesh(geometry, new MeshBasicMaterial({ color: 0x0000ff }));
  const scene = new Scene().add(cutout, solid);
  const camera = new PerspectiveCamera(60, 1, 0.1, 10);
  camera.position.z = 2;
  const center = (32 * 64 + 32) * 4;
  try {
    cutout.renderOrder = -1;
    const blue = await render(scene, camera, 64);
    expect(blue[center + 2]).toBeGreaterThan(200);
    cutout.renderOrder = 1;
    const red = await render(scene, camera, 64);
    expect(red[center]).toBeGreaterThan(200);
  } finally {
    geometry.dispose();
    cutout.material.dispose();
    solid.material.dispose();
  }
});

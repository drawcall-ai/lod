import { BoxGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Sphere, Vector3, type Intersection } from "three/webgpu";
import { expect, it } from "vitest";
import { InstancedLod } from "../../src/instanced/index.js";
import { Wind } from "../../src/wind/index.js";

const shear = new Matrix4().set(1, 0.9, 0.9, 0, 0.9, 1, 0.9, 0, 0.9, 0.9, 1, 0, 0, 0, 0, 1);

function camera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.z = 100;
  camera.updateMatrixWorld();
  return camera;
}

function contains(lod: InstancedLod, matrix: Matrix4, sway = 0): void {
  const point = new Vector3();
  for (const mesh of lod.children) {
    if (!(mesh instanceof InstancedMesh) || !mesh.boundingSphere) throw new Error("Missing level mesh bounds");
    const bounds = mesh.boundingSphere.clone().applyMatrix4(lod.matrixWorld);
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

it("bounds all placed levels and template shear without changing source-based LOD decisions", () => {
  const material = new MeshBasicMaterial();
  const source = new Mesh(new BoxGeometry(2, 2, 2), material);
  source.matrixAutoUpdate = false;
  source.matrix.copy(shear);
  source.updateMatrixWorld(true);
  const coarse = new Mesh(new BoxGeometry(20, 10, 2), material);
  coarse.position.set(30, 10, 0);
  const lod = new InstancedLod([source, coarse], 1);
  const second = lod.levels[1];
  if (!second) throw new Error("Missing coarse level");
  second.maxPixels = 70;
  const view = camera();
  lod.update(view);
  // Source's existing max-axis LOD sphere gives ~52px. Using the full geometry
  // envelope for selection would incorrectly select level zero here.
  expect(lod.levelOf(0)).toBe(1);
  contains(lod, new Matrix4());

  lod.setMatrixAt(0, shear);
  lod.matrixAutoUpdate = false;
  lod.matrix.copy(shear);
  lod.updateMatrixWorld(true);
  lod.update(view);
  contains(lod, shear);
  lod.dispose();
});

it("pads taller coarse levels for the unchanged wind shape and keeps the envelope on clones", () => {
  const material = new MeshBasicMaterial();
  const source = new Mesh(new BoxGeometry(2, 0, 2), material);
  const coarse = new Mesh(new BoxGeometry(2, 100, 2), material);
  coarse.position.y = 50;
  const lod = new InstancedLod([source, coarse], 1);
  const wind = new Wind();
  wind.apply(lod, { amplitude: 1, baseY: 0, height: 1 });
  lod.setMatrixAt(0, shear);
  lod.matrixAutoUpdate = false;
  lod.matrix.copy(shear);
  lod.updateMatrixWorld(true);
  lod.update(camera());
  // Source is flat at the wind base, but the coarse top can move 100 units.
  contains(lod, shear, 1);
  const clone = lod.clone();
  clone.updateMatrixWorld(true);
  clone.update(camera());
  contains(clone, shear, 1);
  clone.dispose();
  lod.dispose();
});

it("raycasts source faces outside the max-axis sphere of a sheared template", () => {
  const source = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
  source.matrixAutoUpdate = false;
  source.matrix.copy(shear);
  source.updateMatrixWorld(true);
  // Three's delegated Mesh.raycast also uses max-axis sphere scaling. A consumer
  // can supply a conservative sphere; our outer broadphase must not reject it first.
  source.geometry.boundingSphere = new Sphere(new Vector3(), 4);
  const lod = new InstancedLod([source], 1);
  const face = new Vector3(0.8, 0.9, 1).applyMatrix4(shear);
  const ray = new Raycaster(face.clone().add(new Vector3(0, 0, 10)), new Vector3(0, 0, -1));
  const hits: Intersection[] = [];
  lod.raycast(ray, hits);
  expect(hits).toHaveLength(1);
  expect(hits[0]?.instanceId).toBe(0);
  expect(hits[0]?.point.distanceTo(face)).toBeLessThan(1e-6);
  lod.dispose();
});

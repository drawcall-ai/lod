import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
  type Object3D,
} from "three/webgpu";
import { expect, it } from "vitest";
import { forEachVertex } from "../../../src/bounds.js";
import { fittedHalfSize } from "../../../src/impostor/bake/fit.js";
import { frameBasis, frameDirection, type Vec3 } from "../../../src/impostor/octahedral.js";

const points = (values: Vec3[]) =>
  new Mesh(new BufferGeometry().setAttribute("position", new BufferAttribute(new Float64Array(values.flat()), 3)), new MeshStandardMaterial());
const directionsOf = (layout: "full" | "hemi", frames: number) =>
  Array.from({ length: frames * frames }, (_, i) => frameDirection(layout, frames, i % frames, Math.floor(i / frames)));

function exhaustive(source: Object3D, centre: Vector3, directions: Vec3[]): number {
  const axes = directions.flatMap((n) => {
    const { tangent, bitangent } = frameBasis(n);
    return [tangent, bitangent];
  });
  let half = 0;
  forEachVertex(source, (p) => {
    p.sub(centre);
    for (const a of axes) half = Math.max(half, Math.abs(p.x * a[0] + p.y * a[1] + p.z * a[2]));
  });
  return half;
}

it("fits boundary and interior vertices exactly across frame layouts and numeric scales", () => {
  let seed = 123456789;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  for (const layout of ["full", "hemi"] as const)
    for (const frames of [2, 3, 4, 8, 16]) {
      const directions = directionsOf(layout, frames);
      for (const scale of [1e-100, 1, 1e100, 1e150]) {
        const vertices: Vec3[] = [];
        for (const n of directions) {
          const { tangent, bitangent } = frameBasis(n);
          for (const a of [tangent, bitangent])
            for (const epsilon of [-Number.EPSILON, 0, Number.EPSILON])
              vertices.push([a[0] * scale * (1 + epsilon), a[1] * scale * (1 + epsilon), a[2] * scale * (1 + epsilon)]);
        }
        for (let i = 0; i < 1000; i++) vertices.push([(random() * 0.5 - 0.25) * scale, (random() * 0.5 - 0.25) * scale, (random() * 0.5 - 0.25) * scale]);
        const source = points(vertices);
        const centre = new Vector3();
        expect(fittedHalfSize(source, centre, directions)).toBe(exhaustive(source, centre, directions));
      }
    }
});

it("fits placed, morphed and instanced vertices relative to the supplied centre", () => {
  const geometry = new SphereGeometry(1, 8, 4);
  geometry.morphAttributes.position = [geometry.getAttribute("position").clone()];
  geometry.morphTargetsRelative = true;
  const mesh = new Mesh(geometry, new MeshStandardMaterial());
  mesh.morphTargetInfluences = [0.5];
  mesh.position.set(3, -1, 2);
  mesh.rotation.set(0.7, 1.1, -0.3);
  mesh.scale.set(2, 0.5, 3);
  const instances = new InstancedMesh(new SphereGeometry(0.5, 8, 4), new MeshStandardMaterial(), 2);
  instances.setMatrixAt(0, new Matrix4().makeTranslation(-4, 2, 1));
  instances.setMatrixAt(1, new Matrix4().makeTranslation(2, 3, -5));
  const source = new Group().add(mesh, instances);
  source.updateMatrixWorld(true);
  const centre = new Vector3(1, 2, -1);
  const directions = directionsOf("hemi", 8);
  expect(fittedHalfSize(source, centre, directions)).toBe(exhaustive(source, centre, directions));
});

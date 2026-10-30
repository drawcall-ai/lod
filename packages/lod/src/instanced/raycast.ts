import { Matrix4, Ray, Sphere, type Intersection, type Mesh, type Object3D, type Raycaster } from "three/webgpu";
import { stretch } from "./blocks.js";
import type { Part } from "./parts.js";

const inverse = new Matrix4();
const ray = new Ray();
const sphere = new Sphere();
const instance = new Matrix4();
const world = new Matrix4();
const hits: Intersection[] = [];

/** A mesh of the source level, as a raycast meets it: the template and where it sits in an instance. */
interface Probe {
  mesh: Mesh;
  placement: Matrix4;
}

/** The source level's meshes, raycast where each instance stands. */
export class Probes {
  private readonly probes: Probe[] = [];

  /** `matrices` are the instances', 16 floats each; `rest` bounds every level in an instance's space. */
  constructor(
    private readonly matrices: Float32Array,
    private readonly rest: Sphere,
  ) {}

  add(parts: readonly Part[]): void {
    const seen = new Set<Mesh>();
    for (const { template, placement } of parts) {
      if (seen.has(template)) continue;
      seen.add(template);
      this.probes.push({ mesh: template, placement });
    }
  }

  /** Hits on `owner`'s instances, with `object` set to `owner` and `instanceId` to the instance. */
  raycast(owner: Object3D, raycaster: Raycaster, intersects: Intersection[]): void {
    ray.copy(raycaster.ray).applyMatrix4(inverse.copy(owner.matrixWorld).invert());
    const count = this.matrices.length / 16;
    for (let i = 0; i < count; i++) {
      instance.fromArray(this.matrices, i * 16);
      sphere.center.copy(this.rest.center).applyMatrix4(instance);
      sphere.radius = this.rest.radius * stretch(instance);
      if (!ray.intersectsSphere(sphere)) continue;
      for (const { mesh, placement } of this.probes) {
        if (!mesh.layers.test(raycaster.layers)) continue;
        // The template's own raycast, as if it stood where this instance does.
        const own = mesh.matrixWorld;
        mesh.matrixWorld = world.multiplyMatrices(owner.matrixWorld, instance).multiply(placement);
        hits.length = 0;
        mesh.raycast(raycaster, hits);
        mesh.matrixWorld = own;
        for (const hit of hits) intersects.push(Object.assign(hit, { object: owner, instanceId: i }));
      }
    }
  }
}

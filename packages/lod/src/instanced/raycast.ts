import { Matrix4, Ray, Sphere, type Intersection, type Mesh, type Object3D, type Raycaster } from "three/webgpu";
import { stretch } from "../three.js";
import type { Part } from "./meshes.js";

/** A Lod's source level as a raycast meets it: its parts, and the sphere around every level in an instance's space. */
export interface RaycastSource {
  readonly parts: readonly Part[];
  readonly rest: Sphere;
}

const inverse = new Matrix4();
const ray = new Ray();
const sphere = new Sphere();
const instance = new Matrix4();
const world = new Matrix4();
const hits: Intersection[] = [];

/**
 * Hits on the first `count` instances of `matrices`, `lod`'s, of `source`'s meshes, each raycast where an instance
 * stands, with `instanceId` set as on an InstancedMesh's hits.
 */
export function raycastInstances(lod: Object3D, source: RaycastSource, matrices: ArrayLike<number>, count: number, raycaster: Raycaster, intersects: Intersection[]): void {
  ray.copy(raycaster.ray).applyMatrix4(inverse.copy(lod.matrixWorld).invert());
  // A mesh of several material groups is a part per group: it is hit once. A mesh's parts share its placement.
  const meshes = new Map<Mesh, Matrix4>();
  for (const { template, placement } of source.parts) if (template.layers.test(raycaster.layers)) meshes.set(template, placement);
  for (let index = 0; index < count; index++) {
    instance.fromArray(matrices, index * 16);
    sphere.center.copy(source.rest.center).applyMatrix4(instance);
    sphere.radius = source.rest.radius * stretch(instance);
    if (sphere.radius === 0 || !ray.intersectsSphere(sphere)) continue;
    for (const [mesh, placement] of meshes)
      for (const hit of hitsAt(mesh, world.multiplyMatrices(lod.matrixWorld, instance).multiply(placement), raycaster)) intersects.push({ ...hit, object: lod, instanceId: index });
  }
}

/** `mesh`'s own raycast, as if it stood at `matrixWorld`. */
function hitsAt(mesh: Mesh, matrixWorld: Matrix4, raycaster: Raycaster): Intersection[] {
  const own = mesh.matrixWorld;
  hits.length = 0;
  mesh.matrixWorld = matrixWorld;
  try {
    mesh.raycast(raycaster, hits);
  } finally {
    mesh.matrixWorld = own;
  }
  return hits;
}

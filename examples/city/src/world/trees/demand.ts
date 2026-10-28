import * as THREE from "three/webgpu";
import { InstancedLod, Lod } from "@drawcall/lod";
import type { Tree } from "./data.ts";
import type { Spot } from "../plan.ts";

interface Region {
  centres: THREE.Sphere;
  radius: number;
}
type Cells = Map<string, { centres: THREE.Box3; radius: number }>;

/** Per-region bounds give an upper screen height without scanning trees during flight. */
export function demand(lods: InstancedLod[], trees: Tree[], sources: THREE.Object3D[], maxPixels: number): (camera: THREE.Camera) => boolean {
  // Demand stays spatial even when rendering combines several regions in one draw.
  const cells: Cells = new Map();
  const matrix = new THREE.Matrix4(),
    centre = new THREE.Vector3(),
    point = new THREE.Vector3();
  for (const lod of lods) {
    const index = sources.indexOf(lod.levels[0]?.object ?? lod);
    const tree = trees[index];
    if (!tree) throw new Error(`${lod.name}: no cached source bounds`);
    const box = new THREE.Box3().setFromArray(tree.impostor.box);
    box.getCenter(centre);
    const own = box.getSize(new THREE.Vector3()).length() / 2;
    for (let i = 0; i < lod.count; i++) {
      lod.getMatrixAt(i, matrix);
      const scale = matrix.getMaxScaleOnAxis();
      if (scale === 0) continue;
      point.copy(centre).applyMatrix4(matrix);
      const key = `${index}:${Math.floor(point.x / 1000)},${Math.floor(point.z / 1000)}`;
      let cell = cells.get(key);
      if (!cell) cells.set(key, (cell = { centres: new THREE.Box3(), radius: 0 }));
      cell.centres.expandByPoint(point);
      cell.radius = Math.max(cell.radius, own * scale);
    }
  }
  return select(cells, maxPixels);
}

/** Entire tiny families stay absent while even their manifest bound is below the cull fade. */
export function culledDemand(spots: readonly Spot[], box: THREE.Box3, maxPixels: number): (camera: THREE.Camera) => boolean {
  const cells: Cells = new Map();
  const own = box.getBoundingSphere(new THREE.Sphere());
  const point = new THREE.Vector3(),
    extent = new THREE.Vector3();
  for (const spot of spots) {
    const radius = own.radius * spot.scale;
    point.set(spot.x, spot.y + own.center.y * spot.scale, spot.z);
    const key = `${Math.floor(point.x / 1000)},${Math.floor(point.z / 1000)}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { centres: new THREE.Box3(), radius: 0 }));
    // The selected variant's exact centre lies inside this whole-asset sphere.
    cell.centres.expandByPoint(extent.copy(point).addScalar(-radius));
    cell.centres.expandByPoint(extent.copy(point).addScalar(radius));
    cell.radius = Math.max(cell.radius, radius);
  }
  return select(cells, maxPixels);
}

function select(cells: Cells, maxPixels: number): (camera: THREE.Camera) => boolean {
  const regions: Region[] = [...cells.values()].map(({ centres, radius }) => ({ centres: centres.getBoundingSphere(new THREE.Sphere()), radius }));
  const eye = new THREE.Vector3();
  return (camera) => {
    eye.setFromMatrixPosition(camera.matrixWorld);
    const scale = (camera.projectionMatrix.elements[5] ?? 0) * innerHeight * Lod.quality;
    for (const region of regions) {
      // Offscreen source trees can still cast into the visible ground's shadow maps.
      const distance = camera.projectionMatrix.elements[15] === 1 ? 1 : Math.max(eye.distanceTo(region.centres.center) - region.centres.radius, 1e-6);
      // Demand just before the float32 GPU fade boundary, including its rounding.
      if ((region.radius * scale) / distance >= maxPixels * (1 - Lod.fade) * (1 - 1e-4)) return true;
    }
    return false;
  };
}

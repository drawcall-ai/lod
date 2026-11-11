import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Materials } from "../shared/materials.ts";
import { detail } from "./detail.ts";
import { houseInterior } from "./interior.ts";
import { low } from "./low.ts";
import { houseParams, type HouseParams } from "./params.ts";

// A building's three assets: the detailed building with its rooms, the low shell its windows bake onto, and the rooms
// alone, which the bake projects into those windows.

/** A building's parameters and how its exterior is shaped; its rooms are always `houseInterior`. */
export interface Building {
  params: HouseParams;
  low(params: HouseParams): THREE.Mesh;
  detail(materials: Materials, params: HouseParams): THREE.Group;
}

/** House variant `variant`, 0-based and below `HOUSE_VARIANTS`. */
export const house = (variant: number): Building => ({ params: houseParams(variant), low, detail });

/** The building as drawn up close: its exterior with the rooms behind its windows. */
export function detailed(materials: Materials, { params, detail }: Building): THREE.Group {
  const rooms = houseInterior(materials, params);
  const group = new THREE.Group().add(detail(materials, params), ...merged(rooms));
  rooms.traverse((node) => {
    if (node instanceof THREE.Mesh) node.geometry.dispose();
  });
  return group;
}

/** The rooms' meshes merged by material, since up close they draw with the building rather than room by room. */
function merged(rooms: THREE.Group): THREE.Mesh[] {
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  rooms.updateMatrixWorld(true);
  rooms.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
    const parts = byMaterial.get(object.material) ?? [];
    if (!byMaterial.has(object.material)) byMaterial.set(object.material, parts);
    parts.push(object.geometry.clone().applyMatrix4(object.matrixWorld));
  });
  return [...byMaterial].map(([material, parts]) => {
    const geometry = mergeGeometries(parts);
    if (!geometry) throw new Error("Room geometries do not merge");
    for (const part of parts) part.dispose();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    return mesh;
  });
}

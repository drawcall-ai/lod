import type { GLTSSource } from "@drawcall/glts";
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { cachedObject } from "../object.ts";
import { churchDetail, churchLow, churchParams } from "./church.ts";
import type { Library } from "../materials.ts";
import { detail } from "./detail.ts";
import * as furnishings from "./furnishings.ts";
import { houseInterior } from "./interior.ts";
import { low } from "./low.ts";
import * as surfaces from "./materials.ts";
import { assetEntry } from "../cache.ts";
import { houseParams, type HouseParams } from "./params.ts";
import type { JsonValue } from "vitecache";

export type HousePart = "source" | "low" | "interior";

/** A house variant's part; `variant` is 0-based, below `HOUSE_VARIANTS`. */
export function house(source: GLTSSource, variant: number, part: HousePart, library: Library): Promise<THREE.Object3D> {
  return building(source, { variant }, houseParams(variant), { low, detail }, part, library);
}

export function church(source: GLTSSource, part: HousePart, library: Library): Promise<THREE.Object3D> {
  return building(source, { church: true }, churchParams(), { low: churchLow, detail: churchDetail }, part, library);
}

/** How a building's exterior is shaped; its rooms are always `houseInterior`. */
interface Shape {
  low(params: HouseParams): THREE.Mesh;
  detail(library: Library, params: HouseParams): THREE.Group;
}

/** Each asset owns its expensive geometry; an overview only requests LodLoader's derived cache. `key` names the building in its cache entry. */
async function building(
  source: GLTSSource,
  key: Record<string, JsonValue>,
  params: HouseParams,
  shape: Shape,
  part: HousePart,
  library: Library,
): Promise<THREE.Object3D> {
  if (part === "low") return library.own(shape.low(params));
  const materials = registerMaterials(library, params);
  await library.ready();
  return cachedObject(assetEntry(source, "house@2", { ...key, part }), library, materials, () => {
    const rooms = library.own(houseInterior(library, params));
    if (part === "interior") return rooms;
    const exterior = library.own(shape.detail(library, params));
    const object = drawn(exterior, rooms);
    library.release(rooms);
    return object;
  });
}

function registerMaterials(library: Library, params: HouseParams): THREE.Material[] {
  // Every wall kind's textures, so each variant reads its cache key from scene.source with the same files loaded,
  // whether it runs alone or in the warm-up loop. Brick and stucco walls share brick's and concrete's textures.
  const materials: THREE.Material[] = [surfaces.wall(library, params), surfaces.whitewash(library)];
  for (const color of [params.trim, params.door, params.shutters, "#1e1f1f"]) if (color) materials.push(surfaces.paint(library, color));
  for (const make of [
    surfaces.glass,
    surfaces.brass,
    surfaces.zinc,
    surfaces.concrete,
    surfaces.plinth,
    surfaces.tiles,
    surfaces.brick,
    surfaces.gravel,
    surfaces.churchStone,
    surfaces.churchSlate,
    furnishings.plaster,
    furnishings.ceiling,
    furnishings.floorboards,
    furnishings.tiles,
    furnishings.fabric,
    furnishings.wood,
    furnishings.gloss,
    furnishings.shade,
  ])
    materials.push(make(library));
  return materials;
}

/** Baking keeps individual room boxes; their displayed geometry is merged once when its asset cache is built. */
function drawn(detail: THREE.Group, rooms: THREE.Group): THREE.Group {
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  rooms.updateMatrixWorld(true);
  rooms.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
    const parts = byMaterial.get(object.material) ?? [];
    if (!byMaterial.has(object.material)) byMaterial.set(object.material, parts);
    parts.push(object.geometry.clone().applyMatrix4(object.matrixWorld));
  });
  const group = new THREE.Group().add(detail);
  for (const [material, parts] of byMaterial) {
    const merged = mergeGeometries(parts);
    if (!merged) throw new Error("Room geometries do not merge");
    const mesh = new THREE.Mesh(merged, material);
    mesh.receiveShadow = true;
    group.add(mesh);
    for (const part of parts) part.dispose();
  }
  return group;
}

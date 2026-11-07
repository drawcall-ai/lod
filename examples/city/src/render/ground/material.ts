import { type Library, baseColor } from "../../../public/content/materials.ts";
import * as THREE from "three/webgpu";
import { cameraPosition, distance, positionWorld, vec4 } from "three/tsl";
import type { Zones } from "../../world/zones.ts";
import { groundShading } from "./shading.ts";

/** The lawn everywhere, for the content viewer. */
export const terrain = (library: Library) =>
  library.material("render/ground/material.ts:terrain", () => terrainMaterial(library, { fields: [], forests: [], parcels: null, town: null }));

/** Ground for anything from a few metres to a few kilometres away, on a mesh whose UVs are world x/z in metres: see `groundShading`. */
export function terrainMaterial(library: Library, zones: Zones): THREE.MeshStandardNodeMaterial {
  const lawn = "Grass001";
  const m = new THREE.MeshStandardNodeMaterial({
    name: "terrain",
    normalMap: library.texture(lawn, "nor"),
    // fully rough: the photo's roughness lets a low sun glare off the lawn like wet tarmac
    roughness: 1,
    aoMap: library.texture(lawn, "arm"),
    metalness: 0,
  });
  const ground = groundShading(library, zones);
  m.colorNode = baseColor.mul(vec4(ground(positionWorld.xz, distance(cameraPosition, positionWorld)), 1));
  return m;
}

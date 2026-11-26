import * as THREE from "three/webgpu";
import { color, float, luminance, mix, normalMap, positionWorld, texture, uv, vec2, vec3, vec4 } from "three/tsl";
import { LAWN_COLOR } from "../world/land.ts";
import { EXTENT } from "../world/terrain.ts";
import type { Textures } from "./materials.ts";

/** RGB holds the local ground tint and alpha the share of bare earth. */
export function groundColor(land: THREE.Texture, xz: THREE.Node<"vec2">) {
  return texture(land, xz.div(2 * EXTENT).add(0.5));
}

export function terrain(textures: Textures, land?: THREE.Texture): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ name: "terrain", roughness: 1 });
  const parcel = land ? groundColor(land, positionWorld.xz) : vec4(color(LAWN_COLOR), 0);
  const grass = texture(textures.get("leafy_grass", "diff"));
  const soil = texture(textures.get("farm_soil", "diff"));
  // Preserve the parcel tint as the photographs mip down to their mean linear colors.
  const detail = mix(grass.rgb.div(vec3(0.32, 0.23, 0.1)), soil.rgb.div(vec3(0.1, 0.05, 0.021)), parcel.a);
  const aerial = texture(textures.get("aerial_grass_rock", "diff"), uv().div(96));
  material.colorNode = parcel.rgb.mul(detail).mul(mix(float(1), luminance(aerial.rgb).div(0.126), 0.55));
  material.normalNode = normalMap(mix(texture(textures.get("leafy_grass", "nor")).xyz, texture(textures.get("farm_soil", "nor")).xyz, parcel.a), vec2(0.55));
  return material;
}

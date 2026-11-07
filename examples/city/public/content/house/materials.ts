import { type Library, type Surface, surface } from "../materials.ts";
import * as THREE from "three/webgpu";
import type { HouseParams } from "./params.ts";

/** Painted joinery: flat colour over a fine wood-grain relief. */
export function paint(library: Library, color: string): Surface {
  return surface(library, "wood_table_001", { albedo: false, color, normalScale: 0.25, roughness: 1.6, weather: 0.35 });
}

/**
 * Window glass: the pane reflects (its Fresnel reflection of the sky carries the look from
 * outside) and lets the room behind show through. Blended as premultiplied light: the
 * reflection is added whole and the room behind is dimmed by the opacity, as with real
 * glass, rather than fading the reflection with it. Its base colour is black, which is
 * also what the baked levels show of it (they bake blended surfaces opaque).
 */
// ior 2.2 gives F0 ≈ 0.14, the combined reflectance of the four faces of double glazing
export const glass = (library: Library) =>
  library.material(
    "house/materials.ts:glass",
    () =>
      new THREE.MeshPhysicalMaterial({
        name: "glass",
        color: "#000000",
        metalness: 0,
        roughness: 0.02,
        ior: 2.2,
        specularIntensity: 1,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      }),
  );

export const brass = (library: Library) =>
  library.material("house/materials.ts:brass", () => new THREE.MeshStandardMaterial({ name: "brass", color: "#b8954f", metalness: 1, roughness: 0.32 }));

export function zinc(library: Library): Surface {
  return surface(library, "metal_plate_02", { albedo: false, color: "#aeb3b4", metalness: 1, normalScale: 0.15, roughness: 0.75, weather: 0.5 });
}

/** Cast stone for sills, steps and the ridge bed. */
export function concrete(library: Library): Surface {
  return surface(library, "white_stucco", { color: "#b9b4ab", normalScale: 1.5, weather: 0.8 });
}

/** Rendered base course, darker than the wall above it. */
export function plinth(library: Library): Surface {
  return surface(library, "white_stucco", { color: "#8f8b84", normalScale: 1.5, weather: 1 });
}

export function wall(library: Library, p: HouseParams): Surface {
  if (p.wall.kind === "brick") return surface(library, "red_brick", { weather: 0.5 });
  if (p.wall.kind === "whitewash") return whitewash(library);
  return surface(library, "white_stucco", { color: p.wall.color, weather: 0.7 });
}

export function whitewash(library: Library): Surface {
  return surface(library, "whitewashed_brick", { weather: 0.6 });
}

/** Clay or slate: per-tile colour lives in vertex colours, the stucco set adds mottling and grain. */
export function tiles(library: Library): Surface {
  return surface(library, "white_stucco", { vertexColors: true, normalScale: 0.9, weather: 0.6 });
}

export function brick(library: Library): Surface {
  return surface(library, "red_brick", { weather: 0.8 });
}

export function gravel(library: Library): Surface {
  return surface(library, "gravel_road", { normalScale: 1.5, weather: 0.3 });
}
export function churchStone(library: Library): Surface {
  return surface(library, "red_brick", { weather: 0.9 });
}
export function churchSlate(library: Library): Surface {
  return surface(library, "white_stucco", { color: "#3a3e44", normalScale: 1.2, weather: 0.5 });
}

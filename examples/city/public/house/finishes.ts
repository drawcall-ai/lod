import { type Materials, surface } from "./materials.ts";
import * as THREE from "three/webgpu";

// Materials of the rooms. Rooms are lit by the sun through the windows and by the sky's
// light; indoors the sky reaches far less than outdoors, so every material here takes a
// fraction of the image-based light. Colours vary per piece through vertex colours.

const INDOORS = 0.12;

/** Painted plaster for walls. */
export const plaster = (materials: Materials) =>
  materials.material("house/finishes.ts:plaster", () =>
    surface(materials, "white_stucco", { vertexColors: true, normalScale: 0.25, roughness: 1.2, envMapIntensity: INDOORS }),
  );

/** Plain white ceilings (a material of their own, so a cutaway can leave them out). */
export const ceiling = (materials: Materials) =>
  materials.material("house/finishes.ts:ceiling", () =>
    surface(materials, "white_stucco", { color: "#f4f2ee", normalScale: 0.2, roughness: 1.2, envMapIntensity: INDOORS }),
  );

export const floorboards = (materials: Materials) =>
  materials.material("house/finishes.ts:floorboards", () =>
    surface(materials, "wood_table_001", { color: "#f2dcb8", normalScale: 0.6, envMapIntensity: INDOORS }),
  );

/** Square ceramic tiles with grout, 30 cm, for kitchens and bathrooms. */
export const tiles = (materials: Materials) =>
  materials.material("house/finishes.ts:tiles", () => {
    const map = new THREE.DataTexture(tilePixels(), TILE_TEXELS, TILE_TEXELS);
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    // two tiles per repeat over UVs in metres
    map.repeat.set(1 / 0.6, 1 / 0.6);
    map.anisotropy = 8;
    map.needsUpdate = true;
    return new THREE.MeshStandardMaterial({ name: "tiles", map, roughness: 0.35, envMapIntensity: INDOORS });
  });

const TILE_TEXELS = 256;

/** Two by two tiles in alternating shades, as sRGB bytes, each inset 3 texels into its grout. */
function tilePixels(): Uint8Array {
  const half = TILE_TEXELS / 2;
  const pixels = new Uint8Array(TILE_TEXELS * TILE_TEXELS * 4);
  for (let y = 0; y < TILE_TEXELS; y++)
    for (let x = 0; x < TILE_TEXELS; x++) {
      const [u, v] = [x % half, y % half];
      const grout = u < 3 || u >= half - 3 || v < 3 || v >= half - 3;
      const odd = (Math.floor(x / half) + Math.floor(y / half)) % 2 === 1;
      const color = grout ? 0x9b958c : odd ? 0xd9d2c4 : 0xe9e4da;
      pixels.set([(color >> 16) & 255, (color >> 8) & 255, color & 255, 255], (y * TILE_TEXELS + x) * 4);
    }
  return pixels;
}

/** Upholstery, rugs, curtains and bedding. */
export const fabric = (materials: Materials) =>
  materials.material(
    "house/finishes.ts:fabric",
    () => new THREE.MeshStandardMaterial({ name: "fabric", vertexColors: true, roughness: 0.95, envMapIntensity: INDOORS, side: THREE.DoubleSide }),
  );

/** Furniture wood: the grain of the table texture under a stain colour. */
export const wood = (materials: Materials) =>
  materials.material("house/finishes.ts:wood", () => surface(materials, "wood_table_001", { vertexColors: true, normalScale: 0.4, envMapIntensity: INDOORS }));

/** Lacquered and ceramic surfaces: kitchen fronts, bath, lamp shades, book covers. */
export const gloss = (materials: Materials) =>
  materials.material(
    "house/finishes.ts:gloss",
    () => new THREE.MeshStandardMaterial({ name: "gloss", vertexColors: true, roughness: 0.35, envMapIntensity: INDOORS }),
  );

/** A lit lamp shade: the rooms' own light when they are baked into a building's windows. */
export const shade = (materials: Materials) =>
  materials.material(
    "house/finishes.ts:shade",
    () =>
      new THREE.MeshStandardMaterial({
        name: "lamp shade",
        color: "#efe8d8",
        emissive: "#ffd9a8",
        emissiveIntensity: 0.9,
        roughness: 0.6,
        side: THREE.DoubleSide,
      }),
  );

export const wallColors = ["#ece6da", "#e3dccb", "#d9e0dc", "#ead8c8", "#d6d9e2", "#efe9d6", "#d8cfbd", "#e6e1e9"];
export const fabricColors = ["#6d7d8c", "#8a6f5a", "#4f6250", "#9c8f7a", "#7a4f4a", "#58606e", "#b7aa92", "#3f4a5a"];
export const woodColors = ["#8a6040", "#a47a52", "#6e4a32", "#c09a70", "#5a3e2c"];

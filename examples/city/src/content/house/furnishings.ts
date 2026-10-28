import * as THREE from "three/webgpu";
import { once, surface } from "../materials.ts";

// Materials of the rooms. Rooms are lit by the sun through the windows and by the sky's
// light; indoors the sky reaches far less than outdoors, so every material here takes a
// fraction of the image-based light. Colours vary per piece through vertex colours.

const INDOORS = 0.12;

/** Painted plaster for walls. */
export const plaster = once(() => surface("white_stucco", { vertexColors: true, normalScale: 0.25, roughness: 1.2, envMapIntensity: INDOORS }));

/** Plain white ceilings (a material of their own, so a cutaway can leave them out). */
export const ceiling = once(() => surface("white_stucco", { color: "#f4f2ee", normalScale: 0.2, roughness: 1.2, envMapIntensity: INDOORS }));

export const floorboards = once(() => surface("wood_table_001", { color: "#f2dcb8", normalScale: 0.6, envMapIntensity: INDOORS }));

/** Square ceramic tiles with grout, 30 cm, for kitchens and bathrooms. */
export const tiles = once(() => {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("2d canvas unavailable");
  g.fillStyle = "#9b958c";
  g.fillRect(0, 0, size, size);
  for (const [x, y, c] of [
    [0, 0, "#e9e4da"],
    [1, 0, "#d9d2c4"],
    [0, 1, "#d9d2c4"],
    [1, 1, "#e9e4da"],
  ] as const) {
    g.fillStyle = c;
    g.fillRect(x * (size / 2) + 3, y * (size / 2) + 3, size / 2 - 6, size / 2 - 6);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  // two tiles per repeat over UVs in metres
  map.repeat.set(1 / 0.6, 1 / 0.6);
  map.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ name: "tiles", map, roughness: 0.35, envMapIntensity: INDOORS });
});

/** Upholstery, rugs, curtains and bedding. */
export const fabric = once(
  () => new THREE.MeshStandardMaterial({ name: "fabric", vertexColors: true, roughness: 0.95, envMapIntensity: INDOORS, side: THREE.DoubleSide }),
);

/** Furniture wood: the grain of the table texture under a stain colour. */
export const wood = once(() => surface("wood_table_001", { vertexColors: true, normalScale: 0.4, envMapIntensity: INDOORS }));

/** Lacquered and ceramic surfaces: kitchen fronts, bath, lamp shades, book covers. */
export const gloss = once(() => new THREE.MeshStandardMaterial({ name: "gloss", vertexColors: true, roughness: 0.35, envMapIntensity: INDOORS }));

/** A lit lamp shade: the rooms' own light when they are baked into a building's windows. */
export const shade = once(
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

export function furnishingMaterial(name: string): THREE.Material | undefined {
  switch (name) {
    case "tiles":
      return tiles();
    case "fabric":
      return fabric();
    case "gloss":
      return gloss();
    case "lamp shade":
      return shade();
    default:
      return undefined;
  }
}

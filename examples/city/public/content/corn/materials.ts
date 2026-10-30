import type { GLTSSource } from "@drawcall/glts";
import type * as THREE from "three/webgpu";
import type { Library } from "../materials.ts";
import { dryLeafMaterial, huskMaterial, leafMaterial, LEAF_SIZE } from "./leaf.ts";
import { tissue } from "./tissue.ts";
import { file, pixelMaterial } from "../cache.ts";

const leaves = [
  { name: "corn-leaf", make: leafMaterial },
  { name: "corn-leaf-dry", make: dryLeafMaterial },
  { name: "corn-husk", make: huskMaterial },
];
const size = LEAF_SIZE * LEAF_SIZE * 4;

export async function registerMaterials(source: GLTSSource, library: Library): Promise<THREE.Material[]> {
  const blades = leaves.map(({ name, make }) =>
    pixelMaterial(source, library, {
      version: "corn-leaf@1",
      name,
      sizes: { color: size, normal: size },
      make: (library, pixels) => make(library, pixels && { color: file(pixels, "color"), normal: file(pixels, "normal") }),
      maps: (leaf) => ({ color: leaf.map, normal: leaf.normalMap }),
    }),
  );
  return [tissue(library), ...(await Promise.all(blades))];
}

import type { GLTSSource } from "@drawcall/glts";
import type { Object3D } from "three/webgpu";
import type { Library } from "../materials.ts";
import { cachedObject } from "../object.ts";
import { assetEntry } from "../cache.ts";
import { cornPlant } from "./index.ts";
import { registerMaterials } from "./materials.ts";

/** The hero plant's leaf tessellation (along, across each blade). */
export const HERO_LEAF: [number, number] = [192, 24];

export async function plant(source: GLTSSource, library: Library, variant: number, hero = false, tassel = true): Promise<Object3D> {
  const materials = await registerMaterials(source, library);
  return cachedObject(assetEntry(source, "corn@3", { variant, hero, tassel }), library, materials, () =>
    // Seeds start at 1: the shapes the variants were tuned with, such as the hero leaf the ladybird sits on.
    cornPlant(library, variant + 1, { leafSegments: hero ? HERO_LEAF : [24, 4], detail: hero ? "fine" : "field", tassel }),
  );
}

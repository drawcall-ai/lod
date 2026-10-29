import * as THREE from "three/webgpu";
import { LodLoader, type LodLevel } from "@drawcall/lod";
import type { Dependencies } from "vitecache";
import { gardenMaterial } from "../content/garden.ts";
import { faceMaterial } from "../content/sign.ts";
import { glass } from "../content/house/materials.ts";
import { restoreSurface, texturesReady } from "../content/materials.ts";

export async function object(dependencies: Dependencies, make: () => THREE.Object3D, cull: number, ratio?: number): Promise<LodLevel[]> {
  const levels = await new LodLoader().loadAsync({
    make: async () => {
      const source = make();
      await texturesReady(source);
      return source;
    },
    key: { ...dependencies, objects: { path: "src/world/objects.ts" } },
    levels: ratio === undefined ? [] : [{ type: "simplify", ratio }],
    material: (name, data) => {
      if (name === "street-sign") {
        if (typeof data.text !== "string") throw new Error("Street sign has no text");
        return faceMaterial(data.text);
      }
      return name === "glass" ? glass() : (gardenMaterial(name) ?? restoreSurface(name, data));
    },
    restore: texturesReady,
  });
  const coarse = levels.at(-1);
  if (coarse?.maxPixels !== undefined) coarse.maxPixels = Math.max(coarse.maxPixels, 2 * cull);
  return [...levels, { object: new THREE.Group(), maxPixels: cull }];
}

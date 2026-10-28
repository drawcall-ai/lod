import * as THREE from "three/webgpu";
import { LodLoader, type Lod, type LevelRequest } from "@drawcall/lod";
import type { Dependencies } from "vitecache";
import { gardenMaterial } from "../content/garden.ts";
import { faceMaterial } from "../content/sign.ts";
import { glass } from "../content/house/materials.ts";
import { restoreSurface, texturesReady } from "../content/materials.ts";

export async function object(dependencies: Dependencies, make: () => THREE.Object3D, cull: number, ratio?: number): Promise<Lod> {
  const levels: LevelRequest[] = [];
  if (ratio !== undefined) levels.push({ type: "mesh", ratio });
  levels.push({ type: "empty", maxPixels: cull });
  return new LodLoader().loadAsync({
    source: async () => {
      const source = make();
      await texturesReady(source);
      return source;
    },
    key: { ...dependencies, objects: { path: "src/world/objects.ts" } },
    levels,
    material: (name, data) => {
      if (name === "street-sign") {
        if (typeof data.text !== "string") throw new Error("Street sign has no text");
        return faceMaterial(data.text);
      }
      return name === "glass" ? glass() : (gardenMaterial(name) ?? restoreSurface(name, data));
    },
    restore: texturesReady,
  });
}

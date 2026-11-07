import * as textureModule from "../public/content/textures.ts";
import * as THREE from "three/webgpu";
import { GLTSLoader } from "@drawcall/glts";
import { LodLoader, type LodLevel, type LodRequest } from "@drawcall/lod";
import { castBothSides } from "./render/sun/casters.ts";

const manager = THREE.DefaultLoadingManager;
export const textures = new textureModule.Textures();
export const scripts = new GLTSLoader(manager, {
  modules: {
    // Every scene borrows one decoded copy of each texture instead of decoding its own.
    [new URL("/content/textures.ts", location.href).href]: { ...textureModule, sharedTextures: textures },
  },
});
import.meta.hot?.dispose(() => {
  scripts.dispose();
  textures.dispose();
});
manager.addHandler(/\.glts$/, scripts);
/** Levels arrive with the shadow sides the sun's casters draw with. */
class Loader extends LodLoader {
  override loadAsync(request: LodRequest): Promise<LodLevel[]> {
    const input = typeof request === "string" ? { url: request } : request;
    return super.loadAsync({
      ...input,
      onLevel: async (object, index) => {
        castBothSides(object);
        await input.onLevel?.(object, index);
      },
    });
  }
}
export const loader = new Loader(manager);

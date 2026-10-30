import * as textureModule from "../public/content/textures.ts";
import * as THREE from "three/webgpu";
import { GLTSLoader } from "@drawcall/glts";
import { LodLoader } from "@drawcall/lod";

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
export const loader = new LodLoader(manager);

import { GLTSLoader } from "@drawcall/glts";
import type { CachedLodLoaderOptions } from "@drawcall/lod";
import * as THREE from "three/webgpu";
import { castBothSides } from "./render/sun/casters.ts";

/** The page's loading manager, which loads .glts sources with `scripts`. */
export const manager = THREE.DefaultLoadingManager;
const scripts = new GLTSLoader(manager);
manager.addHandler(/\.glts$/, scripts);
import.meta.hot?.dispose(() => scripts.dispose());

/** CachedLodLoader options whose levels arrive with the shadow sides the sun's casters draw with, then with `effects`. */
export function arriving(effects?: (object: THREE.Object3D, index: number) => void): CachedLodLoaderOptions {
  return {
    onLevel: (object, index) => {
      castBothSides(object);
      effects?.(object, index);
    },
  };
}

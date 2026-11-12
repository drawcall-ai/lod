import { GLTSLoader } from "@drawcall/glts";
import * as THREE from "three/webgpu";

/** The page's loading manager, which loads .glts sources with `scripts`. */
export const manager = THREE.DefaultLoadingManager;
export const scripts = new GLTSLoader(manager);
manager.addHandler(/\.glts$/, scripts);
import.meta.hot?.dispose(() => scripts.dispose());

import { GLTSLoader } from "@drawcall/glts";
import * as THREE from "three/webgpu";

/**
 * The page's loading manager, which loads .glts sources with `scripts`. It serves the app's root-absolute URLs, such as
 * `/fern/index.glts`, below Vite's base, as a build for a sub-path such as `/lod/` serves them; the GLTS scripts'
 * managers and CachedLodLoader's cache resolve through it too. A manager of its own, not three's default: the loaders
 * the cache plugin runs in Node load with the default one, at paths without the base.
 */
export const manager = new THREE.LoadingManager();
manager.setURLModifier((url) => (url.startsWith("/") && !url.startsWith("//") ? import.meta.env.BASE_URL + url.slice(1) : url));
export const scripts = new GLTSLoader(manager);
manager.addHandler(/\.glts$/, scripts);
import.meta.hot?.dispose(() => scripts.dispose());

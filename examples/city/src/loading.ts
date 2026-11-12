import { GLTSLoader } from "@drawcall/glts";
import * as THREE from "three/webgpu";

/** The page's loading manager, which loads .glts sources with `scripts`. */
export const manager = THREE.DefaultLoadingManager;
export const scripts = new GLTSLoader(manager);
manager.addHandler(/\.glts$/, scripts);
import.meta.hot?.dispose(() => scripts.dispose());

/**
 * A GLTSLoader on the page's manager whose scripts import, in place of the public helper at each path of `helpers`, the
 * namespace given: what the city shares with its assets.
 */
export function sharing(helpers: Record<string, object>): GLTSLoader {
  const modules = Object.fromEntries(Object.entries(helpers).map(([path, namespace]) => [new URL(path, location.href).href, namespace]));
  const loader = new GLTSLoader(manager, { modules });
  import.meta.hot?.dispose(() => loader.dispose());
  return loader;
}

import * as THREE from "three/webgpu";

/**
 * Load-time progress: downloads go through three's default manager (every loader here
 * uses it), building steps (simplifying, baking) through `building`, one item each.
 */
export const building = new THREE.LoadingManager();

/** Runs `build` as one item of `building`, named `name`. */
export async function step<T>(name: string, build: () => Promise<T>): Promise<T> {
  building.itemStart(name);
  try {
    return await build();
  } finally {
    building.itemEnd(name);
  }
}

import * as THREE from "three/webgpu";

/**
 * Load-time progress: downloads go through three's default manager (every loader here
 * uses it), building steps (simplifying, baking) through `building`, one item each.
 */
export const building = new THREE.LoadingManager();

let idle: Promise<void> = Promise.resolve();
const failures = new Set<string>();
THREE.DefaultLoadingManager.onStart = () => {
  idle = new Promise((resolve) => (THREE.DefaultLoadingManager.onLoad = resolve));
};
THREE.DefaultLoadingManager.onError = (url) => failures.add(url);

/** Waits for downloads and bitmap decoding; failed assets cannot reach a bake or first draw. */
export async function downloaded(): Promise<void> {
  await idle;
  if (failures.size) throw new Error(`Unable to load assets: ${[...failures].join(", ")}`);
}

/** Runs `build` as one item of `building`, named `name`. */
export async function step<T>(name: string, build: () => Promise<T>): Promise<T> {
  building.itemStart(name);
  try {
    return await build();
  } finally {
    building.itemEnd(name);
  }
}

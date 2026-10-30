import type { Object3D } from "three/webgpu";
import { isObject3D } from "./three.js";

type Load = () => Promise<Object3D>;
interface Loading {
  promise: Promise<Object3D>;
  object?: Object3D;
  error?: Error;
}
const started = new WeakMap<Load, Loading>();

/** The load `loadOnce` started for `load`, if any. */
export const loading = (load: Load): Loading | undefined => started.get(load);

/** Material dependencies and owners share one load and one resource lifetime. */
export function loadOnce(load: Load): Loading {
  const existing = started.get(load);
  if (existing) return existing;
  const entry: Loading = {
    promise: Promise.resolve()
      .then(load)
      .then((object) => {
        if (!isObject3D(object)) throw new Error("Lod: load must return an Object3D");
        entry.object = object;
        return object;
      })
      .catch((error: unknown) => {
        entry.error = error instanceof Error ? error : new Error("Lod: load failed", { cause: error });
        throw entry.error;
      }),
  };
  started.set(load, entry);
  return entry;
}

import type { Object3D } from "three/webgpu";
import { isObject3D } from "./three.js";

type Load = () => Promise<Object3D>;
interface Decoded {
  promise: Promise<Object3D>;
  object?: Object3D;
  error?: Error;
}
const memo = new WeakMap<Load, Decoded>();

export const decoded = (load: Load): Decoded | undefined => memo.get(load);

/** Material dependencies and owners share one decode and one resource lifetime. */
export function decode(load: Load): Decoded {
  const existing = memo.get(load);
  if (existing) return existing;
  const entry: Decoded = {
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
  memo.set(load, entry);
  return entry;
}

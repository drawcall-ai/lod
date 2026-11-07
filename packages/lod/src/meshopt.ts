import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

let workers = false;

/**
 * three's meshopt decoder, which decodes in two workers from the first use on: sources' glTF buffers and mesh caches.
 * Where there are no workers, as in Node, it decodes on the calling thread.
 */
export function meshoptDecoder(): typeof MeshoptDecoder {
  if (!workers && MeshoptDecoder.supported && typeof Worker !== "undefined") {
    MeshoptDecoder.useWorkers(2);
    workers = true;
  }
  return MeshoptDecoder;
}

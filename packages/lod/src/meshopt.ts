import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { inNode } from "./node-process.js";

/**
 * Whether the decoder's workers were started. useWorkers starts no second set, but each call rebuilds the workers'
 * source (the whole decoder WASM as text) into a new Blob; decodes ask for the decoder often (codec/mesh.ts), so it
 * is started once.
 */
let workers = false;

/**
 * three's meshopt decoder, which decodes in two workers from the first use on: sources' glTF buffers and mesh caches.
 * In Node it decodes on the calling thread. Process-wide, as three's own decoder is.
 */
export function meshoptDecoder(): typeof MeshoptDecoder {
  if (!workers && !inNode && MeshoptDecoder.supported && typeof Worker !== "undefined") {
    MeshoptDecoder.useWorkers(2);
    workers = true;
  }
  return MeshoptDecoder;
}

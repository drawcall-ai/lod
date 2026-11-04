import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

let workers = false;

/** three's meshopt decoder, which decodes in two workers from the first use on: sources' glTF buffers and mesh caches. */
export function meshoptDecoder(): typeof MeshoptDecoder {
  if (!workers && MeshoptDecoder.supported) {
    MeshoptDecoder.useWorkers(2);
    workers = true;
  }
  return MeshoptDecoder;
}

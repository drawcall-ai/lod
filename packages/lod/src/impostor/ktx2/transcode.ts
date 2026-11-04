import { inflateSync } from "fflate";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { LoadingManager, type CompressedTexture } from "three/webgpu";
import type { ImpostorLayer } from "../impostor.js";

let shared: Promise<KTX2Loader> | undefined;

/**
 * One KTX2Loader for every impostor, as three asks. It transcodes to the formats the GPU adapter takes, which are those
 * of any WebGPURenderer device on it: three's WebGPURenderer requests every feature the adapter has. Without WebGPU it
 * transcodes to RGBA. The loader would fetch the Basis transcoder from three's `libs/basis` folder; it reads the copy
 * this package carries instead (see scripts/basis.ts).
 */
function loader(): Promise<KTX2Loader> {
  shared ??= (async () => {
    const [has, { TRANSCODER_JS, TRANSCODER_WASM }] = await Promise.all([adapterFeatures(), import("./wasm/transcoder.js")]);
    const files = { "basis_transcoder.js": blob(TRANSCODER_JS, "text/javascript"), "basis_transcoder.wasm": blob(TRANSCODER_WASM, "application/wasm") };
    const manager = new LoadingManager().setURLModifier((url) => {
      const name = url.slice(url.lastIndexOf("/") + 1);
      return name === "basis_transcoder.js" || name === "basis_transcoder.wasm" ? files[name] : url;
    });
    const loader = new KTX2Loader(manager);
    // What detectSupport finds on a WebGPURenderer; WebGPU has no ETC1, S3TC or PVRTC features.
    loader.workerConfig = {
      astcSupported: has("texture-compression-astc"),
      astcHDRSupported: false,
      etc1Supported: false,
      etc2Supported: has("texture-compression-etc2"),
      dxtSupported: false,
      bptcSupported: has("texture-compression-bc"),
      pvrtcSupported: false,
    };
    return loader;
  })();
  return shared;
}

/** A map's KTX2 file as the blocks of a GPU format, transcoded in three's workers. */
export async function transcode(file: Uint8Array): Promise<ImpostorLayer> {
  const ktx2 = await loader();
  // The loader hands its buffer to a worker.
  const texture = await new Promise<CompressedTexture>((resolve, reject) => ktx2.parse(file.slice().buffer, resolve, reject));
  const mipmaps = texture.mipmaps.map(({ data }) => {
    if (!(data instanceof Uint8Array)) throw new Error(`transcoded to ${data.constructor.name}, not bytes`);
    return data;
  });
  return { format: texture.format, mipmaps };
}

/** A URL of `base64`'s deflated bytes. */
const blob = (base64: string, type: string) => URL.createObjectURL(new Blob([inflateSync(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))], { type }));

/** Whether the default WebGPU adapter has a feature; none without WebGPU. The package's types leave WebGPU's out. */
async function adapterFeatures(): Promise<(feature: string) => boolean> {
  const gpu: unknown = typeof navigator === "undefined" ? undefined : Reflect.get(navigator, "gpu");
  const request: unknown = typeof gpu === "object" && gpu !== null ? Reflect.get(gpu, "requestAdapter") : undefined;
  if (typeof request !== "function") return () => false;
  const adapter: unknown = await Reflect.apply(request, gpu, []);
  const features: unknown = typeof adapter === "object" && adapter !== null ? Reflect.get(adapter, "features") : undefined;
  const has: unknown = typeof features === "object" && features !== null ? Reflect.get(features, "has") : undefined;
  if (typeof has !== "function") return () => false;
  return (feature) => Reflect.apply(has, features, [feature]) === true;
}

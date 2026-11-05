import { inflateSync } from "fflate";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { LoadingManager, type CompressedTexture } from "three/webgpu";
import type { ImpostorLayer } from "../impostor.js";

let shared: Promise<KTX2Loader> | undefined;
/** Transcodes not yet answered, and the timer that disposes the loader once none has been for IDLE_MS. */
let active = 0;
let idle: ReturnType<typeof setTimeout> | undefined;
/** How long the loader outlives its last transcode. Its workers and their transcoders are freed then, so
 *  another library's KTX2Loader (each owns one) is the page's only one but while both transcode. */
const IDLE_MS = 1000;

/**
 * One KTX2Loader for every impostor at a time, as three asks: made at the first transcode, disposed once idle.
 * It transcodes to the formats the GPU adapter takes, which are those
 * of any WebGPURenderer device on it: three's WebGPURenderer requests every feature the adapter has, unless it is given
 * a `device`, which then needs the same texture-compression features. Without WebGPU it transcodes to RGBA. The loader would fetch the Basis transcoder from three's `libs/basis` folder; it reads the copy
 * this package carries instead (see scripts/basis.ts).
 */
function loader(): Promise<KTX2Loader> {
  shared ??= (async () => {
    const [has, files] = await Promise.all([adapterFeatures(), carriedFiles()]);
    const manager = new LoadingManager().setURLModifier((url) => files.get(url) ?? url);
    // given no path, the loader reads files next to its own module, which a build emits under hashed names
    const loader = new KTX2Loader(manager).setTranscoderPath(BASIS);
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
  const texture = await parse(file);
  const mipmaps = texture.mipmaps.map(({ data }) => {
    if (!(data instanceof Uint8Array)) throw new Error(`transcoded to ${data.constructor.name}, not bytes`);
    return data;
  });
  return { format: texture.format, mipmaps };
}

async function parse(file: Uint8Array): Promise<CompressedTexture> {
  clearTimeout(idle);
  active++;
  try {
    const ktx2 = await loader();
    // The loader hands its buffer to a worker.
    return await new Promise<CompressedTexture>((resolve, reject) => ktx2.parse(file.slice().buffer, resolve, reject));
  } finally {
    if (--active === 0) {
      idle = setTimeout(release, IDLE_MS);
      // Releasing frees memory; it must not keep Node.js running once nothing else does.
      const timer: unknown = idle;
      if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref();
    }
  }
}

function release(): void {
  const released = shared;
  shared = undefined;
  void released?.then((loader) => loader.dispose());
}

let carried: Promise<Map<string, string>> | undefined;

/** The carried transcoder's files by the URLs the loader asks for: made once, for every loader made after. */
function carriedFiles(): Promise<Map<string, string>> {
  carried ??= import("./wasm/transcoder.js").then(
    ({ TRANSCODER_JS, TRANSCODER_WASM }) =>
      new Map([
        [`${BASIS}basis_transcoder.js`, blob(TRANSCODER_JS, "text/javascript")],
        [`${BASIS}basis_transcoder.wasm`, blob(TRANSCODER_WASM, "application/wasm")],
      ]),
  );
  return carried;
}

/** Where the loader is told its transcoder lies: the URLs it then asks for map to the carried copy. */
const BASIS = "lod-basis:/";

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

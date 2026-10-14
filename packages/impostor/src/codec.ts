import { unzlibSync, zlibSync } from "fflate";
import {
  KHR_DF_CHANNEL_RGBSDA_ALPHA,
  KHR_DF_CHANNEL_RGBSDA_BLUE,
  KHR_DF_CHANNEL_RGBSDA_GREEN,
  KHR_DF_CHANNEL_RGBSDA_RED,
  KHR_DF_MODEL_RGBSDA,
  KHR_DF_TRANSFER_LINEAR,
  KHR_SUPERCOMPRESSION_ZLIB,
  VK_FORMAT_R8G8B8A8_UNORM,
  createDefaultContainer,
  read,
  write,
} from "ktx-parse";
import { validateImpostor, type Impostor } from "./impostor.js";

/** Key/value entry holding every non-pixel field as JSON. */
const KEY = "impostor";

/**
 * Serializes `impostor` to a KTX2 file: one RGBA8 UNORM 2D array texture with a layer per
 * map, zlib-supercompressed, plus the metadata as JSON under the "impostor" key.
 */
export function encodeImpostor(impostor: Impostor): Uint8Array {
  validateImpostor(impostor);
  const { layers, ...meta } = impostor;
  const raw = new Uint8Array(layers.length * meta.size * meta.size * 4);
  layers.forEach((layer, i) => raw.set(layer, i * layer.length));

  const ktx = createDefaultContainer();
  ktx.vkFormat = VK_FORMAT_R8G8B8A8_UNORM;
  ktx.typeSize = 1;
  ktx.pixelWidth = meta.size;
  ktx.pixelHeight = meta.size;
  ktx.layerCount = layers.length;
  ktx.levelCount = 1;
  ktx.supercompressionScheme = KHR_SUPERCOMPRESSION_ZLIB;
  ktx.levels = [{ levelData: zlibSync(raw, { level: 6 }), uncompressedByteLength: raw.length }];
  // UNORM data must declare a linear transfer; base/emissive are sRGB-encoded but the
  // renderer decodes them itself, as it does with the linear normal/orm layers.
  const channels = [KHR_DF_CHANNEL_RGBSDA_RED, KHR_DF_CHANNEL_RGBSDA_GREEN, KHR_DF_CHANNEL_RGBSDA_BLUE, KHR_DF_CHANNEL_RGBSDA_ALPHA];
  for (const dfd of ktx.dataFormatDescriptor) {
    dfd.colorModel = KHR_DF_MODEL_RGBSDA;
    dfd.transferFunction = KHR_DF_TRANSFER_LINEAR;
    dfd.bytesPlane = [4, 0, 0, 0, 0, 0, 0, 0];
    dfd.samples = channels.map((channelType, i) => ({
      bitOffset: i * 8,
      bitLength: 7, // stored as bits - 1
      channelType,
      samplePosition: [0, 0, 0, 0],
      sampleLower: 0,
      sampleUpper: 255,
    }));
  }
  ktx.keyValue[KEY] = JSON.stringify(meta);
  return write(ktx);
}

/** Parses a file written by `encodeImpostor`, given as bytes or base64. */
export function decodeImpostor(input: Uint8Array | ArrayBuffer | string): Impostor {
  const bytes =
    typeof input === "string"
      ? attempt("not base64", () => fromBase64(input))
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  // ktx-parse reads through `bytes.buffer` without checking the view's end, so a truncated
  // view would read past it; give it a buffer of exactly the file instead.
  const file = bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
  const ktx = attempt("not a KTX2 container", () => read(file));
  if (ktx.vkFormat !== VK_FORMAT_R8G8B8A8_UNORM) fail(`vkFormat ${ktx.vkFormat} is not R8G8B8A8_UNORM`);
  if (ktx.supercompressionScheme !== KHR_SUPERCOMPRESSION_ZLIB) fail(`supercompression ${ktx.supercompressionScheme} is not zlib`);
  if (ktx.pixelWidth !== ktx.pixelHeight) fail(`atlas is ${ktx.pixelWidth}x${ktx.pixelHeight}, not square`);
  const [level] = ktx.levels;
  if (!level || ktx.levels.length !== 1) fail(`expected 1 mip level, got ${ktx.levels.length}`);

  const json = ktx.keyValue[KEY];
  if (!(json instanceof Uint8Array)) fail(`missing "${KEY}" metadata`);
  // ktx-parse returns values of keys not starting with "KTX" as raw bytes, NUL included.
  const meta: unknown = attempt("metadata is not JSON", () => JSON.parse(new TextDecoder().decode(json).replace(/\0$/, "")));
  if (typeof meta !== "object" || meta === null) fail("metadata is not an object");

  const bytesPerLayer = ktx.pixelWidth * ktx.pixelHeight * 4;
  if (level.uncompressedByteLength !== bytesPerLayer * ktx.layerCount) fail("level size does not match the atlas");
  const raw = attempt("level data does not inflate", () => unzlibSync(level.levelData, { out: new Uint8Array(level.uncompressedByteLength) }));
  if (raw.length !== level.uncompressedByteLength) fail("level data inflates to the wrong size");

  // Layers are views into one buffer, in layer-major order as KTX2 stores arrays.
  const layers = Array.from({ length: ktx.layerCount }, (_, i) => raw.subarray(i * bytesPerLayer, (i + 1) * bytesPerLayer));
  const impostor: unknown = { ...meta, layers };
  validateImpostor(impostor);
  return impostor;
}

function fail(why: string): never {
  throw new Error(`Invalid impostor file: ${why}`);
}

/** Runs `run`, turning any throw into an "Invalid impostor file" error. */
function attempt<T>(why: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new Error(`Invalid impostor file: ${why} (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
}

/** Base64 of `bytes`; chunked so tens of megabytes do not overflow the stack. */
export function toBase64(bytes: Uint8Array): string {
  // Native where available (Node 25+, current browsers); the fallback covers the rest.
  const native = (bytes as { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  const chunk = 3 * 0x3000; // a multiple of 3, so chunks concatenate without padding
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunk) parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + chunk))));
  return parts.join("");
}

export function fromBase64(text: string): Uint8Array {
  const native = (Uint8Array as { fromBase64?: (text: string) => Uint8Array }).fromBase64;
  if (native) return native.call(Uint8Array, text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

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
 * map and its baked mip levels, zlib-supercompressed, plus the metadata as JSON under the
 * "impostor" key.
 */
export function encodeImpostor(impostor: Impostor): Uint8Array {
  validateImpostor(impostor);
  const { layers, ...meta } = impostor;
  const levelCount = layers[0]?.length ?? 0;
  // KTX2 stores each mip level with all its array layers, layer-major.
  const levels = Array.from({ length: levelCount }, (_, m) => {
    const bytes = (meta.size >> m) ** 2 * 4;
    const raw = new Uint8Array(layers.length * bytes);
    layers.forEach((layer, i) => raw.set(layer[m] ?? fail(`layer ${i} has no level ${m}`), i * bytes));
    return { levelData: zlibSync(raw, { level: 6 }), uncompressedByteLength: raw.length };
  });

  const ktx = createDefaultContainer();
  ktx.vkFormat = VK_FORMAT_R8G8B8A8_UNORM;
  ktx.typeSize = 1;
  ktx.pixelWidth = meta.size;
  ktx.pixelHeight = meta.size;
  ktx.layerCount = layers.length;
  ktx.levelCount = levels.length;
  ktx.supercompressionScheme = KHR_SUPERCOMPRESSION_ZLIB;
  ktx.levels = levels;
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

type Input = Uint8Array | ArrayBuffer | string;

interface Parsed {
  meta: object;
  layerCount: number;
  levels: { data: Uint8Array; length: number }[];
}

/** Parses a file written by `encodeImpostor`, given as bytes or base64. */
export function decodeImpostor(input: Input): Impostor {
  const file = parse(input);
  const levels = file.levels.map(({ data, length }, m) => attempt(`level ${m} does not inflate`, () => unzlibSync(data, { out: new Uint8Array(length) })));
  return decoded(file, levels);
}

/** Inflate cache files asynchronously with the runtime's native zlib decoder. */
export async function decodeImpostorAsync(input: Input): Promise<Impostor> {
  if (typeof DecompressionStream === "undefined") return decodeImpostor(input);
  const file = parse(input);
  const levels = await Promise.all(
    file.levels.map(async ({ data }, m) => {
      try {
        const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (error) {
        throw invalid(`level ${m} does not inflate`, error);
      }
    }),
  );
  return decoded(file, levels);
}

function parse(input: Input): Parsed {
  const bytes = typeof input === "string" ? attempt("not base64", () => fromBase64(input)) : input instanceof Uint8Array ? input : new Uint8Array(input);
  // ktx-parse reads through `bytes.buffer` without checking the view's end, so a truncated
  // view would read past it; give it a buffer of exactly the file instead.
  const file = bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
  const ktx = attempt("not a KTX2 container", () => read(file));
  if (ktx.vkFormat !== VK_FORMAT_R8G8B8A8_UNORM) fail(`vkFormat ${ktx.vkFormat} is not R8G8B8A8_UNORM`);
  if (ktx.supercompressionScheme !== KHR_SUPERCOMPRESSION_ZLIB) fail(`supercompression ${ktx.supercompressionScheme} is not zlib`);
  if (ktx.pixelWidth !== ktx.pixelHeight) fail(`atlas is ${ktx.pixelWidth}x${ktx.pixelHeight}, not square`);
  const json = ktx.keyValue[KEY];
  if (!(json instanceof Uint8Array)) fail(`missing "${KEY}" metadata`);
  // ktx-parse returns values of keys not starting with "KTX" as raw bytes, NUL included.
  const meta: unknown = attempt("metadata is not JSON", () => JSON.parse(new TextDecoder().decode(json).replace(/\0$/, "")));
  if (typeof meta !== "object" || meta === null) fail("metadata is not an object");
  const levels = ktx.levels.map((level, m) => {
    const bytes = (ktx.pixelWidth >> m) ** 2 * 4;
    if (level.uncompressedByteLength !== bytes * ktx.layerCount) fail(`level ${m} size does not match the atlas`);
    return { data: level.levelData, length: level.uncompressedByteLength };
  });
  return { meta, layerCount: ktx.layerCount, levels };
}

function decoded(file: Parsed, levels: Uint8Array[]): Impostor {
  levels.forEach((raw, m) => {
    if (raw.length !== file.levels[m]?.length) fail(`level ${m} inflates to the wrong size`);
  });
  // Layers share one inflated buffer per mip, in KTX2's layer-major order.
  const layers = Array.from({ length: file.layerCount }, (_, i) =>
    levels.map((raw) => raw.subarray((i * raw.length) / file.layerCount, ((i + 1) * raw.length) / file.layerCount)),
  );
  const impostor: unknown = { ...file.meta, layers };
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
    throw invalid(why, error);
  }
}

function invalid(why: string, error: unknown): Error {
  return new Error(`Invalid impostor file: ${why} (${error instanceof Error ? error.message : String(error)})`, { cause: error });
}

export function fromBase64(text: string): Uint8Array {
  // Native where available (Node 25+, current browsers); the fallback covers the rest.
  const native: unknown = Reflect.get(Uint8Array, "fromBase64");
  const decoded: unknown = typeof native === "function" ? Reflect.apply(native, Uint8Array, [text]) : undefined;
  if (decoded instanceof Uint8Array) return decoded;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

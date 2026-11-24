import { RGBAFormat, type Renderer } from "three/webgpu";
import { pack, unpack } from "../codec/container.js";
import { threeFormat, type BlockFormat } from "../blocks/index.js";
import { encodeBlocks } from "../blocks/encode.js";
import { validateImpostor, type Impostor } from "./impostor.js";

/**
 * Serializes a baked `impostor`: every field but the layers as JSON, then each map's mip levels as blocks of `format`,
 * encoded on `renderer`'s device. A page samples one format (see `BlockFormat`), so store a file per format to serve
 * every page.
 */
export async function encodeImpostorAsync(impostor: Impostor, renderer: Renderer, format: BlockFormat): Promise<Uint8Array> {
  validateImpostor(impostor);
  const { layers, ...meta } = impostor;
  if (layers.some((layer) => layer.format !== RGBAFormat)) throw new Error("encodeImpostorAsync: encode a baked impostor; this one holds compressed blocks");
  const maps = await Promise.all(layers.map((layer) => encodeBlocks(renderer, format, layer.mipmaps, impostor.size)));
  return pack({ ...meta, format }, maps.flat());
}

/** Parses a file written by `encodeImpostorAsync`; its maps' blocks are drawn as they are. */
export async function decodeImpostorAsync(bytes: Uint8Array): Promise<Impostor> {
  const { header, files } = await unpack(bytes, fail);
  if (typeof header !== "object" || header === null) fail("metadata is not an object");
  const { format, ...meta } = Object.fromEntries(Object.entries(header));
  if (format !== "bc7" && format !== "astc") fail("unknown block format");
  const maps: unknown = meta.maps;
  if (!Array.isArray(maps) || maps.length === 0 || files.length % maps.length !== 0) fail("files do not match the maps");
  const levels = files.length / maps.length;
  const layers = maps.map((_, i) => ({ format: threeFormat(format), mipmaps: files.slice(i * levels, (i + 1) * levels) }));
  const impostor: unknown = { ...meta, layers };
  validateImpostor(impostor);
  return impostor;
}

function fail(why: string, cause?: unknown): never {
  throw new Error(`Invalid impostor file: ${why}`, { cause });
}

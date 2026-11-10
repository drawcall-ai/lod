import { read } from "ktx-parse";
import { RGBAFormat } from "three/webgpu";
import { pack, unpack } from "../codec/container.js";
import { validateImpostor, type Impostor, type ImpostorMap } from "./impostor.js";
import { encodeLayer } from "./ktx2/encode.js";
import { transcode } from "./ktx2/transcode.js";

const srgb = (map: ImpostorMap) => map === "base" || map === "emissive";

/**
 * Serializes a baked `impostor`: every field but the layers as JSON, then one KTX2 file per map of GPU-compressible
 * Basis UASTC, encoded in workers. A few seconds for a 1024 atlas.
 */
export async function encodeImpostorAsync(impostor: Impostor): Promise<Uint8Array> {
  validateImpostor(impostor);
  const { layers, ...meta } = impostor;
  const files = await Promise.all(
    layers.map((layer, i) => {
      const map = impostor.maps[i];
      if (!map || layer.format !== RGBAFormat) throw new Error("encodeImpostorAsync: encode a baked impostor; this one holds compressed blocks");
      return encodeLayer({ levels: layer.mipmaps, size: impostor.size, srgb: srgb(map) });
    }),
  );
  return pack(meta, files);
}

/** Parses a file written by `encodeImpostorAsync`, transcoding its maps off the main thread to a format the GPU takes. */
export async function decodeImpostorAsync(bytes: Uint8Array): Promise<Impostor> {
  const { header, files } = await unpack(bytes, fail);
  if (typeof header !== "object" || header === null) fail("metadata is not an object");
  const size: unknown = Reflect.get(header, "size");
  const layers = await Promise.all(
    files.map(async (file, i) => {
      let ktx;
      try {
        ktx = read(file);
      } catch (error) {
        fail(`map ${i} is not a KTX2 file`, error);
      }
      if (ktx.pixelWidth !== size || ktx.pixelHeight !== size) fail(`map ${i} is ${ktx.pixelWidth}x${ktx.pixelHeight}, not the atlas size`);
      try {
        return await transcode(file);
      } catch (error) {
        fail(`map ${i} does not transcode`, error);
      }
    }),
  );
  const impostor: unknown = { ...header, layers };
  validateImpostor(impostor);
  return impostor;
}

function fail(why: string, cause?: unknown): never {
  throw new Error(`Invalid impostor file: ${why}`, { cause });
}

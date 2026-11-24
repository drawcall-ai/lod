import {
  CompressedTexture,
  DataTexture,
  RGBAFormat,
  RGBA_ASTC_4x4_Format,
  RGBA_BPTC_Format,
  UnsignedByteType,
  type CompressedPixelFormat,
  type Texture,
} from "three/webgpu";

// The GPU block formats levels store their maps in. Every WebGPU adapter samples one of them: the spec guarantees
// texture-compression-bc, or texture-compression-etc2 and texture-compression-astc together.

export type BlockFormat = "bc7" | "astc";

/** Every block format, which Node stores each level's maps in, as it builds them for every page. */
export const BLOCK_FORMATS: readonly BlockFormat[] = ["bc7", "astc"];

/** three's format of `format`'s blocks. */
export const threeFormat = (format: BlockFormat): CompressedPixelFormat => (format === "bc7" ? RGBA_BPTC_Format : RGBA_ASTC_4x4_Format);

/** The block format `adapter` samples: BC7 where it has BC, else ASTC 4x4, which it then has. */
export const formatOf = (adapter: GPUAdapter): BlockFormat => (adapter.features.has("texture-compression-bc") ? "bc7" : "astc");

let adapter: Promise<BlockFormat> | undefined;

/**
 * The block format the default WebGPU adapter samples, which every WebGPURenderer on it does: three requests every
 * feature the adapter has, unless given a `device`, which then needs the same texture-compression features.
 */
export function adapterFormat(): Promise<BlockFormat> {
  adapter ??= (async () => {
    const found = typeof navigator === "undefined" ? null : await navigator.gpu?.requestAdapter();
    if (!found) throw new Error("@drawcall/lod: no WebGPU adapter to draw maps with");
    return formatOf(found);
  })();
  return adapter;
}

/** The bytes of a `side`² level of 4x4 blocks of 16 bytes, as BC7 and ASTC 4x4 both are. */
export const blockBytes = (side: number): number => Math.ceil(side / 4) ** 2 * 16;

/** One map's mip levels: RGBA8 texels as baked, or the blocks of a compressed format, `size >> level` square. */
export interface MapLevels {
  format: typeof RGBAFormat | CompressedPixelFormat;
  mipmaps: Uint8Array[];
}

/** A `size`² texture of `map`'s levels. */
export function levelsTexture({ format, mipmaps: levels }: MapLevels, size: number): Texture {
  const mipmaps = levels.map((data, m) => ({ data, width: Math.max(1, size >> m), height: Math.max(1, size >> m) }));
  const [first] = mipmaps;
  if (!first) throw new Error("@drawcall/lod: a map has no mip levels");
  if (format !== RGBAFormat) return new CompressedTexture(mipmaps, size, size, format, UnsignedByteType);
  const texture = new DataTexture(first.data, size, size, RGBAFormat, UnsignedByteType);
  texture.mipmaps = mipmaps;
  return texture;
}

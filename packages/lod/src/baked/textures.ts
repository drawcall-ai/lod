import {
  ClampToEdgeWrapping,
  DataArrayTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  RGFormat,
  SRGBColorSpace,
  UnsignedByteType,
  UVMapping,
  type Renderer,
  type Texture,
} from "three/webgpu";
import { blockBytes, levelsTexture, threeFormat, type BlockFormat } from "../blocks/index.js";
import { encodeBlocks } from "../blocks/encode.js";
import { mipmaps } from "./mips.js";
import { boolean, fail, file, integer, number, numbers, object, type Files } from "./fields.js";

// A baked mesh's textures in its container, their settings as metadata: its surface maps as the blocks of a GPU format,
// which the GPU samples as they are, and the rooms' data textures as their pixels and mips. Only the settings a bake
// makes are accepted.

/**
 * Add `texture`, a bake's square RGBA surface map, to `files` as `name`: its mip levels, or, where it has none, the
 * box-filtered chain the GPU would make, as blocks of `format` encoded on `renderer`'s device. Returns its metadata.
 * The encoding is lossy, so a decoded map loses detail again.
 */
export async function writeMap(files: Files, name: string, texture: Texture | null, renderer: Renderer, format: BlockFormat) {
  const pixels: Files = {};
  const { width, height, depth, channels, srgb, anisotropy, mips } = writeTexture(pixels, name, texture);
  if (depth !== 1 || channels !== 4 || width !== height) fail(`${name} is not a square RGBA map`);
  const base = file(pixels, name + "/0");
  const levels = mips.length
    ? mips.map((_, index) => file(pixels, `${name}/mip${index}`))
    : mipmaps({ data: new Uint8ClampedArray(base.buffer, base.byteOffset, base.byteLength), width, height }, srgb).map(
        ({ data }) => new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
  const blocks = await encodeBlocks(renderer, format, levels, width);
  blocks.forEach((level, m) => (files[`${name}/blocks${m}`] = level));
  return { size: width, levels: blocks.length, srgb, anisotropy };
}

/** The map `writeMap` wrote as `name` in blocks of `format`, with its metadata `value`. */
export function readMap(files: Files, name: string, value: unknown, format: BlockFormat): Texture {
  const meta = object(value);
  const size = integer(meta.size);
  const mipmaps = Array.from({ length: integer(meta.levels) }, (_, m) => file(files, `${name}/blocks${m}`));
  if (mipmaps.length !== Math.log2(size) + 1) fail(`${name} has ${mipmaps.length} levels, not a ${size}² chain`);
  for (const [m, level] of mipmaps.entries()) if (level.length !== blockBytes(Math.max(1, size >> m))) fail(`${name} level ${m} is not whole blocks`);
  const texture = levelsTexture({ format: threeFormat(format), mipmaps }, size);
  texture.colorSpace = boolean(meta.srgb) ? SRGBColorSpace : NoColorSpace;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = number(meta.anisotropy);
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Add `texture`'s pixels and mips to `files` as `name`; returns its metadata. */
export function writeTexture(files: Files, name: string, texture: Texture | null) {
  if (!(texture instanceof DataTexture) && !(texture instanceof DataArrayTexture)) fail(`missing ${name} data texture`);
  const image: unknown = texture.image;
  const base = object(image);
  const width = integer(base.width),
    height = integer(base.height);
  const depth = texture instanceof DataArrayTexture ? integer(base.depth) : 1;
  if (
    texture.type !== UnsignedByteType ||
    (texture.format !== RGBAFormat && texture.format !== RGFormat) ||
    texture.minFilter !== LinearMipmapLinearFilter ||
    texture.magFilter !== LinearFilter ||
    texture.wrapS !== ClampToEdgeWrapping ||
    texture.wrapT !== ClampToEdgeWrapping ||
    texture.flipY ||
    texture.premultiplyAlpha ||
    texture.channel !== 0 ||
    texture.mapping !== UVMapping ||
    !texture.matrixAutoUpdate ||
    texture.internalFormat !== null ||
    texture.offset.x !== 0 ||
    texture.offset.y !== 0 ||
    texture.repeat.x !== 1 ||
    texture.repeat.y !== 1 ||
    texture.rotation !== 0 ||
    (texture.colorSpace !== SRGBColorSpace && texture.colorSpace !== NoColorSpace)
  )
    fail(`unsupported ${name} texture settings`);
  const channels = texture.format === RGFormat ? 2 : 4;
  const pixels = (value: unknown, width: number, height: number) => {
    if (!(value instanceof Uint8Array) || value.byteLength !== width * height * depth * channels) fail(`invalid ${name} pixels`);
    return value;
  };
  files[name + "/0"] = pixels(base.data, width, height);
  const mips = texture.mipmaps.map((value, index) => {
    const mip = object(value);
    const w = integer(mip.width),
      h = integer(mip.height);
    if (w !== Math.max(1, width >> index) || h !== Math.max(1, height >> index)) fail("invalid mip dimensions");
    files[`${name}/mip${index}`] = pixels(mip.data, w, h);
    return [w, h];
  });
  return {
    width,
    height,
    depth,
    channels,
    srgb: texture.colorSpace === SRGBColorSpace,
    anisotropy: texture.anisotropy,
    generateMipmaps: texture.generateMipmaps,
    unpackAlignment: texture.unpackAlignment,
    mips,
  };
}

/** The texture `writeTexture` wrote as `name`, with its metadata `value`: an array texture if `array`. */
export function readTexture(files: Files, name: string, value: unknown, array: true): DataArrayTexture;
export function readTexture(files: Files, name: string, value: unknown, array: false): DataTexture;
export function readTexture(files: Files, name: string, value: unknown, array: boolean): DataArrayTexture | DataTexture {
  const meta = object(value);
  const width = integer(meta.width),
    height = integer(meta.height),
    depth = integer(meta.depth);
  const channels = meta.channels === 2 ? 2 : meta.channels === 4 ? 4 : fail("invalid texture channels");
  if (!array && depth !== 1) fail("2D texture with layers");
  const pixels = (key: string, width: number, height: number) => {
    const data = file(files, key);
    if (data.byteLength !== width * height * depth * channels) fail(`invalid ${key} byte length`);
    return data;
  };
  const data = pixels(name + "/0", width, height);
  const texture = array ? new DataArrayTexture(data, width, height, depth) : new DataTexture(data, width, height);
  texture.format = channels === 2 ? RGFormat : RGBAFormat;
  texture.colorSpace = boolean(meta.srgb) ? SRGBColorSpace : NoColorSpace;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = number(meta.anisotropy);
  texture.generateMipmaps = boolean(meta.generateMipmaps);
  const alignment = meta.unpackAlignment;
  if (alignment !== 1 && alignment !== 2 && alignment !== 4 && alignment !== 8) fail("invalid texture alignment");
  texture.unpackAlignment = alignment;
  if (!Array.isArray(meta.mips)) fail("missing mipmaps");
  texture.mipmaps = meta.mips.map((value, index) => {
    const size = numbers(value, 2);
    const w = integer(size[0]),
      h = integer(size[1]);
    if (w !== Math.max(1, width >> index) || h !== Math.max(1, height >> index)) fail("invalid mip dimensions");
    return { data: pixels(`${name}/mip${index}`, w, h), width: w, height: h };
  });
  texture.needsUpdate = true;
  return texture;
}

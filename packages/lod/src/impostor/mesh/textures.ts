import {
  CompressedTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  type Texture,
} from "three/webgpu";
import type { Impostor, ImpostorLayer } from "../impostor.js";

/** `impostor`'s atlases as textures, one per map: an ImpostorMaterial's, freed with it. */
export function impostorTextures(impostor: Impostor): Texture[] {
  return impostor.layers.map((layer, i) => {
    const texture = textureOf(layer, impostor.size);
    const map = impostor.maps[i];
    texture.colorSpace = map === "base" || map === "emissive" ? SRGBColorSpace : NoColorSpace;
    // The baked levels; the chain ends at one texel per frame.
    texture.generateMipmaps = false;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.needsUpdate = true;
    return texture;
  });
}

function textureOf({ format, mipmaps: levels }: ImpostorLayer, size: number): Texture {
  const mipmaps = levels.map((data, m) => ({ data, width: size >> m, height: size >> m }));
  const [first] = mipmaps;
  if (!first) throw new Error("ImpostorMesh: a layer has no mip levels");
  if (format !== RGBAFormat) return new CompressedTexture(mipmaps, size, size, format, UnsignedByteType);
  const texture = new DataTexture(first.data, size, size, RGBAFormat, UnsignedByteType);
  texture.mipmaps = mipmaps;
  return texture;
}

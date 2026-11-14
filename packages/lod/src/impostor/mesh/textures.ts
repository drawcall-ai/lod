import { LinearFilter, LinearMipmapLinearFilter, NoColorSpace, SRGBColorSpace, type Texture } from "three/webgpu";
import { transcodedTexture } from "../../ktx2/transcode.js";
import type { Impostor } from "../impostor.js";

/** `impostor`'s atlases as textures, one per map: an ImpostorMaterial's, freed with it. */
export function impostorTextures(impostor: Impostor): Texture[] {
  return impostor.layers.map((layer, i) => {
    const texture = transcodedTexture(layer, impostor.size);
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

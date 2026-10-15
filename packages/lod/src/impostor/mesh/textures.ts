import { DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RGBAFormat, SRGBColorSpace, UnsignedByteType } from "three";
import type { Impostor } from "../impostor.js";

/** One set of GPU textures per impostor, shared by every mesh drawing it. */
const shared = new WeakMap<Impostor, { textures: DataTexture[]; users: number }>();

export function acquireTextures(impostor: Impostor): DataTexture[] {
  let entry = shared.get(impostor);
  if (!entry) {
    const textures = impostor.layers.map((levels, i) => {
      const mipmaps = levels.map((data, m) => ({ data, width: impostor.size >> m, height: impostor.size >> m }));
      const [first] = mipmaps;
      if (!first) throw new Error("ImpostorMesh: a layer has no mip levels");
      const texture = new DataTexture(first.data, impostor.size, impostor.size, RGBAFormat, UnsignedByteType);
      const map = impostor.maps[i];
      texture.colorSpace = map === "base" || map === "emissive" ? SRGBColorSpace : NoColorSpace;
      // The baked levels; the chain ends at one texel per frame, and an immutable
      // texture with fewer levels than a full chain is complete without the rest.
      texture.mipmaps = mipmaps;
      texture.generateMipmaps = false;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.magFilter = LinearFilter;
      texture.needsUpdate = true;
      return texture;
    });
    entry = { textures, users: 0 };
    shared.set(impostor, entry);
  }
  entry.users++;
  return entry.textures;
}

export function releaseTextures(impostor: Impostor): void {
  const entry = shared.get(impostor);
  if (!entry || --entry.users > 0) return;
  for (const texture of entry.textures) texture.dispose();
  shared.delete(impostor);
}

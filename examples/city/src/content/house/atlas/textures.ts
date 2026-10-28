import { Box2, DataArrayTexture, Vector2, Vector3, type Renderer, type Texture } from "three/webgpu";

/** Equal-sized house maps in separate layers: repeat and every original mip survive. */
export class TextureArray {
  readonly texture: DataArrayTexture;
  private readonly layers = new Map<Texture, number>();

  constructor(renderer: Renderer, maps: readonly (Texture | null)[], name: string) {
    const sources = [...new Set(maps.filter((map) => map !== null))];
    const first = sources[0];
    if (!first) throw new Error(`${name}: no textures`);
    const { width, height } = dimensions(first);
    for (const source of sources) {
      const size = dimensions(source);
      if (size.width !== width || size.height !== height) throw new Error(`${name}: texture sizes differ`);
      const keys: (keyof Texture)[] = ["format", "type", "colorSpace", "wrapS", "wrapT", "magFilter", "minFilter", "anisotropy", "premultiplyAlpha", "flipY"];
      for (const key of keys) {
        if (source[key] !== first[key]) throw new Error(`${name}: texture ${key} differs`);
      }
      renderer.initTexture(source);
    }
    const texture = new DataArrayTexture(null, width, height, sources.length);
    texture.name = name;
    texture.format = first.format;
    texture.type = first.type;
    texture.colorSpace = first.colorSpace;
    texture.wrapS = first.wrapS;
    texture.wrapT = first.wrapT;
    texture.magFilter = first.magFilter;
    texture.minFilter = first.minFilter;
    texture.anisotropy = first.anisotropy;
    texture.premultiplyAlpha = first.premultiplyAlpha;
    // Allocate GPU storage without a second CPU copy of these full-resolution maps.
    texture.source.dataReady = false;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    this.texture = texture;
    try {
      renderer.initTexture(texture);
      // Keep the allocated mip chain; each level is copied, never regenerated.
      texture.generateMipmaps = false;
      const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
      sources.forEach((source, layer) => {
        this.layers.set(source, layer);
        for (let mip = 0; mip < levels; mip++) {
          const region = new Box2(new Vector2(), new Vector2(Math.max(1, width >> mip), Math.max(1, height >> mip)));
          renderer.copyTextureToTexture(source, texture, region, new Vector3(0, 0, layer), mip, mip);
        }
      });
    } catch (error) {
      texture.dispose();
      throw error;
    }
  }

  layer(map: Texture | null): number {
    if (map === null) return -1;
    const layer = this.layers.get(map);
    if (layer === undefined) throw new Error(`${this.texture.name}: texture is not in the atlas`);
    return layer;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

function dimensions(texture: Texture): { width: number; height: number } {
  const image: unknown = texture.image;
  if (!texture.generateMipmaps || texture.mipmaps.length) throw new Error(`${texture.name}: expected generated house texture mips`);
  if (image instanceof ImageBitmap && image.width > 0 && image.height > 0) return { width: image.width, height: image.height };
  if (!(image instanceof HTMLImageElement) || !image.complete || image.naturalWidth === 0) throw new Error(`${texture.name}: house texture is not loaded`);
  return { width: image.naturalWidth, height: image.naturalHeight };
}

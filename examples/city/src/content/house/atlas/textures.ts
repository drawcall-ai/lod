import { DataArrayTexture, type Texture } from "three/webgpu";

interface TexturePixels {
  width: number;
  height: number;
  depth: number;
  data: Uint8Array;
}

/** Cached pixels upload and generate their mip chain only when the level is compiled. */
export class TextureArray {
  readonly texture: DataArrayTexture;
  readonly pixels: TexturePixels;
  private readonly layers = new Map<string, number>();

  constructor(
    maps: readonly (Texture | null)[],
    name: string,
    pixels?: TexturePixels,
    private readonly identify: (texture: Texture) => string = (texture) => texture.uuid,
  ) {
    const sources = [...new Map(maps.filter((map) => map !== null).map((map) => [identify(map), map])).values()];
    const first = sources[0];
    if (!first) throw new Error(`${name}: no textures`);
    for (const [layer, source] of sources.entries()) {
      const keys: (keyof Texture)[] = ["format", "type", "colorSpace", "wrapS", "wrapT", "magFilter", "minFilter", "anisotropy", "premultiplyAlpha", "flipY"];
      for (const key of keys) if (source[key] !== first[key]) throw new Error(`${name}: texture ${key} differs`);
      this.layers.set(identify(source), layer);
    }
    this.pixels = pixels ?? read(sources);
    const { data, width, height, depth } = this.pixels;
    if (depth !== sources.length || data.length !== width * height * depth * 4) throw new Error(`${name}: invalid cached texture array`);
    const texture = new DataArrayTexture(data, width, height, depth);
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
    texture.flipY = first.flipY;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    this.texture = texture;
  }

  layer(map: Texture | null): number {
    if (map === null) return -1;
    const layer = this.layers.get(this.identify(map));
    if (layer === undefined) throw new Error(`${this.texture.name}: texture is not in the atlas`);
    return layer;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

function read(sources: Texture[]): TexturePixels {
  const images = sources.map((source) => {
    const image: unknown = source.image;
    if (!(image instanceof ImageBitmap || image instanceof HTMLImageElement)) throw new Error(`${source.name}: house texture is not loaded`);
    return image;
  });
  const first = images[0];
  if (!first || first.width === 0 || first.height === 0) throw new Error("House texture has no pixels");
  const { width, height } = first;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("House atlas needs a canvas pixel reader");
  const data = new Uint8Array(width * height * images.length * 4);
  images.forEach((image, layer) => {
    if (image.width !== width || image.height !== height) throw new Error("House texture sizes differ");
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0);
    data.set(context.getImageData(0, 0, width, height).data, layer * width * height * 4);
  });
  return { width, height, depth: images.length, data };
}

import { ClampToEdgeWrapping, MirroredRepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType, type Texture, type Wrapping } from "three";

/** One mip of an RGBA8 image, row 0 first. */
export interface Mip {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * A texture's texels on the CPU, with a box-filtered mip chain like the GPU's, sampled
 * trilinearly in its UV space (its matrix, wrapping and flipY applied). An sRGB texture is
 * filtered and returned in linear values, as the GPU decodes before filtering. Every
 * texture is read through the `uv` attribute: `texture.channel` is ignored. The pixels
 * are read at the first sample: a texture nothing samples is never read.
 */
export class Texels {
  /** |det| of the texture matrix: how much it scales UV area */
  readonly uvScale: number;
  /** 8-bit value to 0..1, per channel: colour channels decode sRGB if the texture is sRGB */
  private readonly decode: Float32Array[];
  /** the texture's UV transform (Matrix3 elements, column-major) */
  readonly matrix: number[];
  private readonly wrapS: Wrapping;
  private readonly wrapT: Wrapping;
  private readonly lower = new Float32Array(4);
  private readonly upper = new Float32Array(4);
  private read: { mips: Mip[]; flipY: boolean } | null = null;

  constructor(private readonly texture: Texture) {
    this.decode = decoders(texture.colorSpace === SRGBColorSpace);
    if (texture.matrixAutoUpdate) texture.updateMatrix();
    this.matrix = texture.matrix.elements.slice();
    const [a = 1, b = 0, , c = 0, d = 1] = this.matrix;
    this.uvScale = Math.abs(a * d - b * c);
    this.wrapS = texture.wrapS;
    this.wrapT = texture.wrapT;
  }

  get width(): number {
    return this.base().width;
  }

  get height(): number {
    return this.base().height;
  }

  private base(): Mip {
    return this.pixels().mips[0] ?? missing();
  }

  private pixels(): { mips: Mip[]; flipY: boolean } {
    if (this.read) return this.read;
    const { texture } = this;
    const { data, width, height, rowsUp } = pixels(texture);
    // Row 0 of the pixels is v = 1 when they were uploaded flipped.
    this.read = { mips: mipmaps({ data, width, height }, texture.colorSpace === SRGBColorSpace), flipY: texture.flipY && !rowsUp };
    return this.read;
  }

  /** The texel at (u, v) from mip `mip` (fractional: trilinear) into `out`, channels 0..1. */
  sample(u: number, v: number, mip: number, out: Float32Array): void {
    const [m0 = 1, m1 = 0, , m3 = 0, m4 = 1, , m6 = 0, m7 = 0] = this.matrix;
    const su = wrap(m0 * u + m3 * v + m6, this.wrapS);
    const tv = wrap(m1 * u + m4 * v + m7, this.wrapT);
    const { mips, flipY } = this.pixels();
    const sv = flipY ? 1 - tv : tv;
    const top = mips.length - 1;
    const l = Math.min(Math.max(mip, 0), top);
    const l0 = Math.floor(l);
    const f = l - l0;
    this.bilinear(l0, su, sv, f > 0 ? this.lower : out);
    if (f === 0) return;
    this.bilinear(Math.min(l0 + 1, top), su, sv, this.upper);
    for (let k = 0; k < 4; k++) out[k] = (this.lower[k] ?? 0) * (1 - f) + (this.upper[k] ?? 0) * f;
  }

  private bilinear(mip: number, su: number, sv: number, out: Float32Array): void {
    const { data, width, height } = this.pixels().mips[mip] ?? missing();
    const x = su * width - 0.5;
    const y = sv * height - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const cx = (i: number) => (this.wrapS === ClampToEdgeWrapping ? Math.min(Math.max(i, 0), width - 1) : ((i % width) + width) % width);
    const cy = (i: number) => (this.wrapT === ClampToEdgeWrapping ? Math.min(Math.max(i, 0), height - 1) : ((i % height) + height) % height);
    const a = (cy(y0) * width + cx(x0)) * 4;
    const b = (cy(y0) * width + cx(x0 + 1)) * 4;
    const c = (cy(y0 + 1) * width + cx(x0)) * 4;
    const d = (cy(y0 + 1) * width + cx(x0 + 1)) * 4;
    for (let k = 0; k < 4; k++) {
      const decode = this.decode[k] ?? missing();
      const top = (decode[data[a + k] ?? 0] ?? 0) * (1 - fx) + (decode[data[b + k] ?? 0] ?? 0) * fx;
      const bottom = (decode[data[c + k] ?? 0] ?? 0) * (1 - fx) + (decode[data[d + k] ?? 0] ?? 0) * fx;
      out[k] = top * (1 - fy) + bottom * fy;
    }
  }
}

const missing = (): never => {
  throw new Error("Texels: lookup out of range");
};

export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.min(c, 1), 1 / 2.4) - 0.055);

function wrap(x: number, mode: Wrapping): number {
  if (mode === ClampToEdgeWrapping) return Math.min(Math.max(x, 0), 1);
  if (mode === MirroredRepeatWrapping) {
    const f = ((x % 2) + 2) % 2;
    return f > 1 ? 2 - f : f;
  }
  return x - Math.floor(x);
}

/** Whether `pixels` can read `texture` on the CPU. */
export function readable(texture: Texture): boolean {
  if ("isCompressedTexture" in texture) return false;
  const image: unknown = texture.image;
  if (isData(image)) return texture.format === RGBAFormat && texture.type === UnsignedByteType;
  return drawable(image) !== null;
}

/** The texture's 8-bit RGBA pixels; `rowsUp` when row 0 is v = 0 whatever flipY says. */
function pixels(texture: Texture): Mip & { rowsUp: boolean } {
  const image = texture.image;
  if ("isCompressedTexture" in texture) throw new Error(`cannot read compressed texture "${texture.name}" on the CPU`);
  if (isData(image)) {
    if (texture.format !== RGBAFormat || texture.type !== UnsignedByteType)
      throw new Error(`cannot read data texture "${texture.name}" on the CPU: it is not 8-bit RGBA`);
    const data = new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.width * image.height * 4);
    // Data textures are uploaded as they are.
    return { data, width: image.width, height: image.height, rowsUp: true };
  }
  const source = drawable(image);
  if (!source) throw new Error(`cannot read the image of texture "${texture.name}" on the CPU`);
  const { width, height } = source;
  const context = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("no 2D canvas to read textures with");
  context.drawImage(source, 0, 0);
  const { data } = context.getImageData(0, 0, width, height, { colorSpace: "srgb" });
  // ImageBitmaps ignore flipY on upload.
  return { data, width, height, rowsUp: typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap };
}

function isData(image: unknown): image is { data: Uint8Array | Uint8ClampedArray; width: number; height: number } {
  if (typeof image !== "object" || image === null || !("data" in image)) return false;
  return image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray;
}

/** `image` as something a 2D canvas draws, if it is one. */
function drawable(image: unknown): (CanvasImageSource & { width: number; height: number }) | null {
  const kinds = [globalThis.ImageBitmap, globalThis.HTMLImageElement, globalThis.HTMLCanvasElement, globalThis.OffscreenCanvas];
  for (const kind of kinds) if (kind && image instanceof kind) return image;
  return null;
}

/** Per channel, 8-bit value to 0..1: the colour channels of an sRGB image decode to linear. */
function decoders(srgb: boolean): Float32Array[] {
  const linear = Float32Array.from({ length: 256 }, (_, i) => i / 255);
  const color = srgb ? linear.map(srgbToLinear) : linear;
  return [color, color, color, linear];
}

/**
 * `base` and its box-filtered halvings down to 1×1, as generateMipmap makes them: an sRGB
 * image is averaged in linear values.
 */
export function mipmaps(base: Mip, srgb: boolean): Mip[] {
  const decode = decoders(srgb);
  const encode = (value: number, channel: number) => (srgb && channel < 3 ? linearToSrgb(value) : value);
  const mips = [base];
  let mip = base;
  while (mip.width > 1 || mip.height > 1) {
    const { data: from, width: w, height: h } = mip;
    const width = Math.max(1, w >> 1);
    const height = Math.max(1, h >> 1);
    const data = new Uint8ClampedArray(width * height * 4);
    for (let k = 0; k < 4; k++) {
      const d = decode[k] ?? missing();
      for (let y = 0; y < height; y++) {
        const row0 = Math.min(y * 2, h - 1) * w;
        const row1 = Math.min(y * 2 + 1, h - 1) * w;
        for (let x = 0; x < width; x++) {
          const x0 = Math.min(x * 2, w - 1);
          const x1 = Math.min(x * 2 + 1, w - 1);
          const sum =
            (d[from[(row0 + x0) * 4 + k] ?? 0] ?? 0) +
            (d[from[(row0 + x1) * 4 + k] ?? 0] ?? 0) +
            (d[from[(row1 + x0) * 4 + k] ?? 0] ?? 0) +
            (d[from[(row1 + x1) * 4 + k] ?? 0] ?? 0);
          data[(y * width + x) * 4 + k] = encode(sum / 4, k) * 255;
        }
      }
    }
    mips.push((mip = { data, width, height }));
  }
  return mips;
}

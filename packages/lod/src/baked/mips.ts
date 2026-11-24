// Mip chains of baked maps, and the sRGB transfer functions they average in.

/** One mip of an RGBA8 image, row 0 first. */
export interface Mip {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.min(c, 1), 1 / 2.4) - 0.055);

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
      const d = decode[k];
      if (!d) throw new Error("mipmaps: an image has four channels");
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

// The part of @drawcall/webgpu this package uses, which ships no types.
declare module "@drawcall/webgpu" {
  export interface Canvas {
    dispose(): Promise<void>;
  }
  export function createCanvas(width: number, height: number): Promise<Canvas>;
  /** The straight-alpha sRGB pixels of `bitmap`. */
  export function readImageBitmap(bitmap: ImageBitmap): { readonly data: Uint8ClampedArray };
}

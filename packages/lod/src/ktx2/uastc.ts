import { inflateSync } from "fflate";
import type { Job } from "./encode.js";

/** The members of Basis's encoder bindings (embind, see basisu's webgl/encoder) that an encode uses. */
interface BasisEncoder {
  setCreateKTX2File(on: boolean): void;
  setUASTC(on: boolean): void;
  setTexType(type: number): void;
  setSliceSourceImage(slice: number, data: Uint8Array, width: number, height: number, format: number): boolean;
  setPerceptual(on: boolean): void;
  setKTX2AndBasisSRGBTransferFunc(on: boolean): void;
  setMipGen(on: boolean): void;
  setPackUASTCFlags(flags: number): void;
  setKTX2UASTCSupercompression(on: boolean): void;
  encode(out: Uint8Array): number;
  delete(): void;
}
interface Basis {
  BasisEncoder: new () => BasisEncoder;
  initializeBasis(): void;
}

/** Encodes rows of a mip level as a KTX2 file. */
export type Encode = (job: Job) => Uint8Array<ArrayBuffer>;

/**
 * basisu's encoder, started from its Emscripten module's factory and binary (see `encoderSources`): it encodes rows of
 * a mip level as a KTX2 file of UASTC LDR 4x4, Zstandard supercompressed if the job asks, at level 1 (see `packFlags`)
 * and without RDO, which would trade normal accuracy for size. The encoder's own mips would filter level 0, so each
 * baked level is encoded on its own (see `encodeLayer`).
 *
 * Self-contained, using no import or name from outside its body, since browser workers run its source text (see
 * `encode.ts`).
 */
export async function basisEncoder(factory: unknown, wasmBinary: Uint8Array): Promise<Encode> {
  if (typeof factory !== "function") throw new Error("the Basis encoder module has no factory");
  // the module names its binary relative to its own URL, which a data: or blob: URL's is not: named, then given. It
  // prints every image's progress, which nothing needs.
  const basis: unknown = await factory({ wasmBinary, locateFile: (name: string) => name, print: () => {} });
  const isBasis = (value: unknown): value is Basis =>
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "BasisEncoder") === "function" &&
    typeof Reflect.get(value, "initializeBasis") === "function";
  if (!isBasis(basis)) throw new Error("the Basis encoder module lacks its bindings");
  basis.initializeBasis();
  // basisu's pack flags: level 1, which encodes about twice as fast as the default level 2 and loses under 0.1 dB on
  // albedo and normal maps (level 0 loses 1 to 4 dB), with the fastest ETC1 hints (128), which only transcodes to ETC1
  // and ETC2 read; three picks those only on a GPU without ASTC and BC texture compression, which WebGPU adapters on
  // desktops and most phones have.
  const packFlags = 1 | 128;

  return ({ data, width, height, srgb, supercompress }) => {
    const encoder = new basis.BasisEncoder();
    try {
      encoder.setCreateKTX2File(true);
      encoder.setUASTC(true);
      // basisu's enums: texture type 0 is a 2D texture; image format 0 is raw RGBA8
      encoder.setTexType(0);
      if (!encoder.setSliceSourceImage(0, data, width, height, 0)) throw new Error(`the Basis encoder took no ${width}x${height} image`);
      encoder.setPerceptual(srgb);
      encoder.setKTX2AndBasisSRGBTransferFunc(srgb);
      encoder.setMipGen(false);
      encoder.setPackUASTCFlags(packFlags);
      encoder.setKTX2UASTCSupercompression(supercompress);
      const out = new Uint8Array(4 * width * height + 65536);
      const length = encoder.encode(out);
      if (length === 0) throw new Error(`the Basis encoder failed on a ${width}x${height} image`);
      return out.slice(0, length);
    } finally {
      encoder.delete();
    }
  };
}

/** The Emscripten module's source and its binary, inflated from the package's copies (see scripts/basis.ts). */
export async function encoderSources(): Promise<{ js: string; wasm: Uint8Array<ArrayBuffer> }> {
  const { ENCODER_JS, ENCODER_WASM } = await import("./wasm/encoder.js");
  return { js: new TextDecoder().decode(inflate(ENCODER_JS)), wasm: inflate(ENCODER_WASM) };
}

const inflate = (base64: string) => inflateSync(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));

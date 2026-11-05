import { inflateSync } from "fflate";
import type { Job } from "./encode.js";
import { ENCODER_JS, ENCODER_WASM } from "./wasm/encoder.js";

/** The members of Basis's encoder bindings (embind, see basisu's webgl/encoder) that `encode` uses. */
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

let basis: Promise<Basis> | undefined;

/**
 * basisu's pack flags: level 1, which encodes about twice as fast as the default level 2 and loses under 0.1 dB on
 * albedo and normal maps (level 0 loses 1 to 4 dB), with the fastest ETC1 hints (128), which only transcodes to ETC1
 * and ETC2 read; three picks those only on a GPU without ASTC and BC texture compression, which WebGPU adapters on
 * desktops and most phones have.
 */
const PACK_FLAGS = 1 | 128;

/**
 * Rows of a mip level as a KTX2 file of UASTC LDR 4x4 with Zstandard supercompression, at level 1 (see PACK_FLAGS) and
 * without RDO, which would trade normal accuracy for size. The encoder's own mips would filter level 0, so each baked
 * level is encoded on its own (see `encodeLayer`).
 */
export async function encode({ data, width, height, srgb }: Job): Promise<Uint8Array> {
  const encoder = new (await (basis ??= load())).BasisEncoder();
  try {
    encoder.setCreateKTX2File(true);
    encoder.setUASTC(true);
    // basisu's enums: texture type 0 is a 2D texture; image format 0 is raw RGBA8
    encoder.setTexType(0);
    if (!encoder.setSliceSourceImage(0, data, width, height, 0)) throw new Error(`the Basis encoder took no ${width}x${height} image`);
    encoder.setPerceptual(srgb);
    encoder.setKTX2AndBasisSRGBTransferFunc(srgb);
    encoder.setMipGen(false);
    encoder.setPackUASTCFlags(PACK_FLAGS);
    encoder.setKTX2UASTCSupercompression(true);
    const out = new Uint8Array(4 * width * height + 65536);
    const length = encoder.encode(out);
    if (length === 0) throw new Error(`the Basis encoder failed on a ${width}x${height} image`);
    return out.slice(0, length);
  } finally {
    encoder.delete();
  }
}

/**
 * The encoder's Emscripten module (see scripts/basis.ts), started on its binary. Imported from a data: URL, which
 * browsers and Node both import, unlike a blob: URL.
 */
async function load(): Promise<Basis> {
  const url = `data:text/javascript,${encodeURIComponent(new TextDecoder().decode(inflate(ENCODER_JS)))}`;
  const factory: unknown = (await import(/* @vite-ignore */ url)).default;
  if (typeof factory !== "function") throw new Error("the Basis encoder module has no factory");
  // the module names its binary relative to its own URL, which a data: URL's is not: named, then given
  const basis: unknown = await factory({ wasmBinary: inflate(ENCODER_WASM), locateFile: (name: string) => name });
  if (!isBasis(basis)) throw new Error("the Basis encoder module lacks its bindings");
  basis.initializeBasis();
  return basis;
}

function isBasis(value: unknown): value is Basis {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "BasisEncoder") === "function" &&
    typeof Reflect.get(value, "initializeBasis") === "function"
  );
}

const inflate = (base64: string) => inflateSync(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));

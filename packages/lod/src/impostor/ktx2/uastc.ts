import { inflateSync } from "fflate";
import { read, write } from "ktx-parse";
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
 * One map as a KTX2 file of UASTC LDR 4x4 with Zstandard supercompression, at basisu's default effort and without RDO,
 * which would trade normal accuracy for size. The encoder's own mips would filter level 0, so each baked level is
 * encoded as a file of one level, and the files' levels are joined.
 */
export async function encode({ levels, size, srgb }: Job): Promise<Uint8Array> {
  basis ??= load();
  const module = await basis;
  const files = levels.map((data, m) => read(encodeLevel(module, data, size >> m, srgb)));
  const [first] = files;
  if (!first) throw new Error("no mip levels");
  first.levels = files.map((file) => file.levels[0] ?? fail());
  first.levelCount = files.length;
  return write(first);
}

function encodeLevel(module: Basis, data: Uint8Array, width: number, srgb: boolean): Uint8Array {
  const encoder = new module.BasisEncoder();
  try {
    encoder.setCreateKTX2File(true);
    encoder.setUASTC(true);
    // basisu's enums: texture type 0 is a 2D texture; image format 0 is raw RGBA8
    encoder.setTexType(0);
    if (!encoder.setSliceSourceImage(0, data, width, width, 0)) throw new Error(`the Basis encoder took no ${width}² level`);
    encoder.setPerceptual(srgb);
    encoder.setKTX2AndBasisSRGBTransferFunc(srgb);
    encoder.setMipGen(false);
    encoder.setPackUASTCFlags(2);
    encoder.setKTX2UASTCSupercompression(true);
    const out = new Uint8Array(4 * width * width + 65536);
    const length = encoder.encode(out);
    if (length === 0) throw new Error(`the Basis encoder failed on a ${width}² level`);
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

function fail(): never {
  throw new Error("the encoder wrote a file without levels");
}

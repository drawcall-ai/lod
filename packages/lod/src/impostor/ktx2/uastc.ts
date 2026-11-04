import { inflateSync } from "fflate";
import { read, write } from "ktx-parse";
import { encodeToKTX2 } from "ktx2-encoder";
import type { Job } from "./encode.js";
import { ENCODER_WASM } from "./wasm/encoder.js";

let wasm: string | undefined;

/**
 * One map as a KTX2 file of UASTC LDR 4x4 with Zstandard supercompression, at basisu's default effort and without RDO,
 * which would trade normal accuracy for size. The encoder's own mips would filter level 0, so each baked level is
 * encoded as a file of one level, and the files' levels are joined.
 */
export async function encode({ levels, size, srgb }: Job): Promise<Uint8Array> {
  wasm ??= URL.createObjectURL(new Blob([inflateSync(Uint8Array.from(atob(ENCODER_WASM), (c) => c.charCodeAt(0)))], { type: "application/wasm" }));
  const files = [];
  for (const [m, data] of levels.entries()) {
    const width = size >> m;
    const file = await encodeToKTX2(data, {
      wasmUrl: wasm,
      imageDecoder: async () => ({ width, height: width, data }),
      isUASTC: true,
      uastcLDRQualityLevel: 2,
      enableRDO: false,
      needSupercompression: true,
      generateMipmap: false,
      isPerceptual: srgb,
      isSetKTX2SRGBTransferFunc: srgb,
    });
    files.push(read(file));
  }
  const [first] = files;
  if (!first) throw new Error("no mip levels");
  first.levels = files.map((file) => file.levels[0] ?? fail());
  first.levelCount = files.length;
  return write(first);
}

function fail(): never {
  throw new Error("the encoder wrote a file without levels");
}

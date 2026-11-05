import { inflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import { encodeLayer } from "../../../src/impostor/ktx2/encode.js";
import { encode } from "../../../src/impostor/ktx2/uastc.js";
import { TRANSCODER_JS, TRANSCODER_WASM } from "../../../src/impostor/ktx2/wasm/transcoder.js";

describe("impostor map encoding", () => {
  it("encodes each level in strips to the blocks it encodes to whole, whatever its size and strip count", { timeout: 60_000 }, async () => {
    for (const size of [8, 36, 100])
      for (const parts of [1, 2, 3, 4]) {
        const levels = [image(size), image(size >> 1)];
        const file = await encodeLayer({ levels, size, srgb: true }, parts);
        for (const [m, data] of levels.entries()) {
          const whole = await encode({ data, width: size >> m, height: size >> m, srgb: true });
          expect(await transcodes(file, m)).toEqual(await transcodes(whole, 0));
        }
      }
  });
});

/** An RGBA8 `size`² image of gradients and noise, as baked maps hold. */
function image(size: number): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  let seed = 1;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    data[i] = ((i >> 2) % size) * 2 + (seed % 48);
  }
  return data;
}

const inflate = (base64: string) => inflateSync(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));

/** basisu's transcoder formats: BC7, ASTC 4x4 and RGBA32. */
const FORMATS = [6, 10, 13];

interface KTX2File {
  isValid(): boolean;
  startTranscoding(): boolean;
  getImageTranscodedSizeInBytes(level: number, layer: number, face: number, format: number): number;
  transcodeImage(out: Uint8Array, level: number, layer: number, face: number, format: number, flags: number, channel0: number, channel1: number): number;
  close(): void;
  delete(): void;
}

interface Transcoder {
  KTX2File: new (file: Uint8Array) => KTX2File;
  initializeBasis(): void;
}
const isTranscoder = (value: unknown): value is Transcoder =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "KTX2File") === "function" &&
  typeof Reflect.get(value, "initializeBasis") === "function";

let transcoder: Promise<Transcoder> | undefined;

/** Level `level` of `file` in each of `FORMATS`, as three's KTX2Loader transcodes it. */
async function transcodes(file: Uint8Array, level: number): Promise<Uint8Array[]> {
  transcoder ??= (async () => {
    const module = { exports: {} };
    new Function("module", "exports", new TextDecoder().decode(inflate(TRANSCODER_JS)))(module, module.exports);
    const factory: unknown = module.exports;
    if (typeof factory !== "function") throw new Error("the Basis transcoder module has no factory");
    const basis: unknown = await factory({ wasmBinary: inflate(TRANSCODER_WASM) });
    if (!isTranscoder(basis)) throw new Error("the Basis transcoder module lacks its bindings");
    basis.initializeBasis();
    return basis;
  })();
  const { KTX2File } = await transcoder;
  return FORMATS.map((format) => {
    const ktx2 = new KTX2File(file);
    try {
      if (!ktx2.isValid() || !ktx2.startTranscoding()) throw new Error("not a transcodable KTX2 file");
      const out = new Uint8Array(ktx2.getImageTranscodedSizeInBytes(level, 0, 0, format));
      if (!ktx2.transcodeImage(out, level, 0, 0, format, 0, -1, -1)) throw new Error(`no transcode to format ${format}`);
      return out;
    } finally {
      ktx2.close();
      ktx2.delete();
    }
  });
}

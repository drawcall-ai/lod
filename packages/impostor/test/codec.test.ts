import { describe, expect, it } from "vitest";
import { read, write, VK_FORMAT_R8G8B8A8_SRGB, KHR_DF_MODEL_RGBSDA, KHR_SUPERCOMPRESSION_ZLIB } from "ktx-parse";
import { decodeImpostor, encodeImpostor, fromBase64, toBase64 } from "../src/codec.js";
import type { Impostor, ImpostorMap } from "../src/impostor.js";

function random(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 255;
  }
  return out;
}

function make(maps: ImpostorMap[], size = 32, frames = 8): Impostor {
  return {
    version: 1,
    layout: "hemi",
    frames,
    size,
    box: [-1, 0, -0.5, 1, 2.25, 0.5],
    halfSize: 1.6,
    maps,
    layers: maps.map((_, i) => random(size * size * 4, i + 7)),
  };
}

describe("codec", () => {
  it("round-trips metadata either side of 256 bytes", () => {
    // ktx-parse 1.1 wrote key/value lengths as one byte: 256 became 0, 257 became 1.
    const long = (k: number) => (k + 1 / 7) / 3e7; // about 22 characters each in JSON
    for (const box of [
      [-1, 0, -1, 1, 2, 1],
      [-long(1), -long(2), -long(3), long(4), long(5), long(6)],
    ] as Impostor["box"][]) {
      const impostor = { ...make(["base", "normalDepth", "orm", "emissive"]), box, halfSize: 1 / 3 };
      const { layers: _, ...meta } = impostor;
      const entry = "impostor".length + 1 + JSON.stringify(meta).length + 1;
      expect(entry < 200 || entry > 270).toBe(true);
      const back = decodeImpostor(encodeImpostor(impostor));
      expect(back.box).toEqual(box);
      expect(back.halfSize).toBe(1 / 3);
    }
  });

  it("round-trips 3 and 4 layers byte-exact", () => {
    const sets: ImpostorMap[][] = [["base", "normalDepth", "orm"], ["base", "normalDepth", "orm", "emissive"]];
    for (const maps of sets) {
      const source = make(maps);
      const back = decodeImpostor(encodeImpostor(source));
      expect(back.layers.length).toBe(maps.length);
      back.layers.forEach((layer, i) => expect(Buffer.compare(layer, source.layers[i]!)).toBe(0));
      const { layers: _a, ...meta } = back;
      const { layers: _b, ...expected } = source;
      expect(meta).toEqual(expected);
    }
  });

  it("writes a valid RGBA8 UNORM zlib array texture", () => {
    const ktx = read(encodeImpostor(make(["base", "normalDepth", "orm"], 64)));
    expect(ktx.vkFormat).toBe(37);
    expect(ktx.typeSize).toBe(1);
    expect([ktx.pixelWidth, ktx.pixelHeight, ktx.pixelDepth, ktx.layerCount, ktx.faceCount, ktx.levelCount]).toEqual([64, 64, 0, 3, 1, 1]);
    expect(ktx.supercompressionScheme).toBe(KHR_SUPERCOMPRESSION_ZLIB);
    expect(ktx.levels[0]!.uncompressedByteLength).toBe(64 * 64 * 4 * 3);
    const dfd = ktx.dataFormatDescriptor[0]!;
    expect(dfd.colorModel).toBe(KHR_DF_MODEL_RGBSDA);
    expect(dfd.bytesPlane[0]).toBe(4);
    expect(dfd.samples.map((s) => [s.bitOffset, s.bitLength, s.channelType, s.sampleUpper])).toEqual([
      [0, 7, 0, 255],
      [8, 7, 1, 255],
      [16, 7, 2, 255],
      [24, 7, 15, 255],
    ]);
  });

  it("accepts ArrayBuffer, offset views and base64", () => {
    const source = make(["base", "normalDepth", "orm"]);
    const file = encodeImpostor(source);
    const padded = new Uint8Array(file.length + 16);
    padded.set(file, 16);
    const views = [file.slice().buffer, padded.subarray(16), toBase64(file)];
    for (const input of views) expect(Buffer.compare(decodeImpostor(input).layers[1]!, source.layers[1]!)).toBe(0);
  });

  it("base64 matches Node, natively and through the fallback", () => {
    const native = (Uint8Array as { fromBase64?: unknown }).fromBase64;
    for (const n of [0, 1, 2, 3, 4, 5, 36863, 36864, 36865]) {
      const bytes = random(n, n + 1);
      const expected = Buffer.from(bytes).toString("base64");
      expect(toBase64(bytes)).toBe(expected);
      // An own undefined property hides the native method, as on runtimes without it.
      Object.defineProperty(bytes, "toBase64", { value: undefined });
      expect(toBase64(bytes)).toBe(expected);
      Object.defineProperty(Uint8Array, "fromBase64", { value: undefined, configurable: true, writable: true });
      try {
        expect(Buffer.compare(fromBase64(expected), bytes)).toBe(0);
      } finally {
        Object.defineProperty(Uint8Array, "fromBase64", { value: native, configurable: true, writable: true });
      }
    }
  });

  it("rejects corrupt files with clear errors", () => {
    const file = encodeImpostor(make(["base", "normalDepth", "orm"]));
    const bad = (input: Uint8Array | string, pattern: RegExp) => expect(() => decodeImpostor(input)).toThrow(pattern);
    bad(new Uint8Array(64), /Invalid impostor file: not a KTX2 container/);
    bad(file.subarray(0, 40), /Invalid impostor file: not a KTX2 container/);
    bad("not base64!", /Invalid impostor file: not base64/);
    bad(toBase64(file.subarray(0, file.length - 200)), /Invalid impostor file/);

    const edit = (change: (ktx: ReturnType<typeof read>) => void) => {
      const ktx = read(file.slice());
      change(ktx);
      return write(ktx);
    };
    bad(edit((k) => (k.vkFormat = VK_FORMAT_R8G8B8A8_SRGB)), /vkFormat 43 is not R8G8B8A8_UNORM/);
    bad(edit((k) => (k.supercompressionScheme = 2)), /supercompression 2 is not zlib/);
    bad(edit((k) => delete k.keyValue.impostor), /missing "impostor" metadata/);
    bad(edit((k) => (k.keyValue.impostor = new TextEncoder().encode("{oops\0"))), /metadata is not JSON/);
    bad(edit((k) => (k.layerCount = 2)), /level size does not match/);
    bad(edit((k) => (k.levels[0]!.levelData = new Uint8Array([1, 2, 3, 4]))), /level data/);
    bad(
      edit((k) => (k.keyValue.impostor = new TextEncoder().encode(JSON.stringify({ ...make(["base", "normalDepth", "orm"]), layers: undefined, frames: 5 }) + "\0"))),
      /Invalid impostor: size .*multiple of frames/,
    );
  });

  it("encode validates its input", () => {
    expect(() => encodeImpostor({ ...make(["base", "normalDepth", "orm"]), maps: ["base", "orm", "normalDepth"] })).toThrow(/Invalid impostor/);
  });
});

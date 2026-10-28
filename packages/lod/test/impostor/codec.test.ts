import { describe, expect, it } from "vitest";
import { read, write, VK_FORMAT_R8G8B8A8_SRGB, KHR_DF_MODEL_RGBSDA, KHR_SUPERCOMPRESSION_ZLIB } from "ktx-parse";
import { decodeImpostor, decodeImpostorAsync, encodeImpostor, fromBase64 } from "../../src/impostor/codec.js";
import type { Impostor, ImpostorMap } from "../../src/impostor/impostor.js";
import { must } from "../must.js";

const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

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
    version: 3,
    layout: "hemi",
    frames,
    size,
    box: [-1, 0, -0.5, 1, 2.25, 0.5],
    halfSize: 1.6,
    maps,
    layers: maps.map((_, i) => Array.from({ length: Math.log2(size / frames) + 1 }, (_, m) => random((size >> m) ** 2 * 4, i * 16 + m + 7))),
  };
}

describe("codec", () => {
  it("synchronous and asynchronous decode preserve all metadata and bytes for every input form", async () => {
    const sets: ImpostorMap[][] = [
      ["base", "normalDepth", "orm"],
      ["base", "normalDepth", "orm", "emissive"],
    ];
    for (const maps of sets) {
      const source = make(maps, 128, 8);
      if (maps.length === 4) source.specular = [0.03, 0.06, 0.08, 1];
      const { layers: expectedLayers, ...expectedMeta } = source;
      const file = encodeImpostor(source),
        padded = new Uint8Array(file.length + 17);
      padded.set(file, 17);
      for (const input of [file, file.slice().buffer, padded.subarray(17), toBase64(file)]) {
        const actual = await decodeImpostorAsync(input);
        const sync = decodeImpostor(input);
        for (const decoded of [sync, actual]) {
          const { layers, ...meta } = decoded;
          expect(meta).toEqual(expectedMeta);
          expect(layers.map((layer) => layer.length)).toEqual(expectedLayers.map((layer) => layer.length));
          layers.forEach((layer, i) => layer.forEach((mip, m) => expect(sameBytes(mip, must(expectedLayers[i]?.[m]))).toBe(true)));
        }
        // Each mip has one owner buffer, shared by every map's view.
        expect(actual.layers[0]?.[0]?.buffer).toBe(actual.layers[1]?.[0]?.buffer);
      }
    }
  });

  it("uses the same decoder when native decompression is unavailable", async () => {
    const native = Object.getOwnPropertyDescriptor(globalThis, "DecompressionStream");
    Object.defineProperty(globalThis, "DecompressionStream", { value: undefined, configurable: true });
    try {
      const file = encodeImpostor(make(["base", "normalDepth", "orm"]));
      expect(await decodeImpostorAsync(file)).toEqual(decodeImpostor(file));
    } finally {
      if (native) Object.defineProperty(globalThis, "DecompressionStream", native);
      else Reflect.deleteProperty(globalThis, "DecompressionStream");
    }
  });
  it("round-trips metadata either side of 256 bytes", () => {
    // ktx-parse 1.1 wrote key/value lengths as one byte: 256 became 0, 257 became 1.
    const long = (k: number) => (k + 1 / 7) / 3e7; // about 22 characters each in JSON
    const boxes: Impostor["box"][] = [
      [-1, 0, -1, 1, 2, 1],
      [-long(1), -long(2), -long(3), long(4), long(5), long(6)],
    ];
    for (const box of boxes) {
      const impostor = { ...make(["base", "normalDepth", "orm", "emissive"]), box, halfSize: 1 / 3 };
      const { layers: _, ...meta } = impostor;
      const entry = "impostor".length + 1 + JSON.stringify(meta).length + 1;
      expect(entry < 200 || entry > 270).toBe(true);
      const back = decodeImpostor(encodeImpostor(impostor));
      expect(back.box).toEqual(box);
      expect(back.halfSize).toBe(1 / 3);
    }
  });

  it("writes a valid RGBA8 UNORM zlib array texture", () => {
    const ktx = read(encodeImpostor(make(["base", "normalDepth", "orm"], 64)));
    expect(ktx.vkFormat).toBe(37);
    expect(ktx.typeSize).toBe(1);
    expect([ktx.pixelWidth, ktx.pixelHeight, ktx.pixelDepth, ktx.layerCount, ktx.faceCount, ktx.levelCount]).toEqual([64, 64, 0, 3, 1, 4]);
    expect(ktx.supercompressionScheme).toBe(KHR_SUPERCOMPRESSION_ZLIB);
    expect(ktx.levels.map((level) => level.uncompressedByteLength)).toEqual([64, 32, 16, 8].map((size) => size * size * 4 * 3));
    const dfd = must(ktx.dataFormatDescriptor[0]);
    expect(dfd.colorModel).toBe(KHR_DF_MODEL_RGBSDA);
    expect(dfd.bytesPlane[0]).toBe(4);
    expect(dfd.samples.map((s) => [s.bitOffset, s.bitLength, s.channelType, s.sampleUpper])).toEqual([
      [0, 7, 0, 255],
      [8, 7, 1, 255],
      [16, 7, 2, 255],
      [24, 7, 15, 255],
    ]);
  });

  it("decodes base64 natively and through the fallback", () => {
    const native: unknown = Reflect.get(Uint8Array, "fromBase64");
    for (const n of [0, 1, 2, 3, 4, 5, 36863, 36864, 36865]) {
      const bytes = random(n, n + 1);
      const expected = toBase64(bytes);
      expect(sameBytes(fromBase64(expected), bytes)).toBe(true);
      // An undefined property hides the native method, as on runtimes without it.
      Object.defineProperty(Uint8Array, "fromBase64", { value: undefined, configurable: true, writable: true });
      try {
        expect(sameBytes(fromBase64(expected), bytes)).toBe(true);
      } finally {
        Object.defineProperty(Uint8Array, "fromBase64", { value: native, configurable: true, writable: true });
      }
    }
  });

  it("rejects corrupt files with clear errors", async () => {
    const file = encodeImpostor(make(["base", "normalDepth", "orm"]));
    const pending: Promise<unknown>[] = [];
    const bad = (input: Uint8Array | string, pattern: RegExp) => {
      expect(() => decodeImpostor(input)).toThrow(pattern);
      pending.push(expect(decodeImpostorAsync(input)).rejects.toThrow(pattern));
    };
    bad(new Uint8Array(64), /Invalid impostor file: not a KTX2 container/);
    bad(file.subarray(0, 40), /Invalid impostor file: not a KTX2 container/);
    bad("not base64!", /Invalid impostor file: not base64/);
    bad(toBase64(file.subarray(0, file.length - 200)), /Invalid impostor file/);

    const edit = (change: (ktx: ReturnType<typeof read>) => void) => {
      const ktx = read(file.slice());
      change(ktx);
      return write(ktx);
    };
    bad(
      edit((k) => (k.vkFormat = VK_FORMAT_R8G8B8A8_SRGB)),
      /vkFormat 43 is not R8G8B8A8_UNORM/,
    );
    bad(
      edit((k) => (k.supercompressionScheme = 2)),
      /supercompression 2 is not zlib/,
    );
    bad(
      edit((k) => delete k.keyValue.impostor),
      /missing "impostor" metadata/,
    );
    bad(
      edit((k) => (k.keyValue.impostor = new TextEncoder().encode("{oops\0"))),
      /metadata is not JSON/,
    );
    bad(
      edit((k) => (k.layerCount = 2)),
      /level 0 size does not match/,
    );
    bad(
      edit((k) => (must(k.levels[0]).levelData = new Uint8Array([1, 2, 3, 4]))),
      /level 0 does not inflate/,
    );
    bad(
      edit(
        (k) =>
          (k.keyValue.impostor = new TextEncoder().encode(JSON.stringify({ ...make(["base", "normalDepth", "orm"]), layers: undefined, frames: 5 }) + "\0")),
      ),
      /Invalid impostor: size .*multiple of frames/,
    );
    await Promise.all(pending);
  });

  it("encode validates its input", () => {
    expect(() => encodeImpostor({ ...make(["base", "normalDepth", "orm"]), maps: ["base", "orm", "normalDepth"] })).toThrow(/Invalid impostor/);
  });
});

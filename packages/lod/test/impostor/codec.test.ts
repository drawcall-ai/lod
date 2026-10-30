import { describe, expect, it, vi } from "vitest";
import { read, write, VK_FORMAT_R8G8B8A8_SRGB, KHR_DF_MODEL_RGBSDA, KHR_SUPERCOMPRESSION_ZLIB } from "ktx-parse";
import { decodeImpostorAsync, encodeImpostor } from "../../src/impostor/codec.js";
import type { Impostor, ImpostorMap } from "../../src/impostor/impostor.js";
import { must } from "../must.js";

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
  it("decoding preserves all metadata and bytes, also from a view into a larger buffer", async () => {
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
      for (const input of [file, padded.subarray(17)]) {
        const actual = await decodeImpostorAsync(input);
        const { layers, ...meta } = actual;
        expect(meta).toEqual(expectedMeta);
        expect(layers.map((layer) => layer.length)).toEqual(expectedLayers.map((layer) => layer.length));
        layers.forEach((layer, i) => layer.forEach((mip, m) => expect(sameBytes(mip, must(expectedLayers[i]?.[m]))).toBe(true)));
        // Each mip has one owner buffer, shared by every map's view.
        expect(actual.layers[0]?.[0]?.buffer).toBe(actual.layers[1]?.[0]?.buffer);
      }
    }
  });

  it("inflates large mips in a worker without consuming the cached file", async () => {
    const source = make(["base", "normalDepth", "orm"], 1024);
    const file = encodeImpostor(source);
    const copy = file.slice();
    const post = vi.spyOn(Worker.prototype, "postMessage");
    try {
      const actual = await decodeImpostorAsync(file);
      expect(post).toHaveBeenCalled();
      expect(sameBytes(file, copy)).toBe(true);
      actual.layers.forEach((layer, i) => layer.forEach((mip, m) => expect(sameBytes(mip, must(source.layers[i]?.[m]))).toBe(true)));
      expect(actual.layers[0]?.[0]?.buffer).toBe(actual.layers[1]?.[0]?.buffer);
    } finally {
      post.mockRestore();
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

  it("rejects corrupt files with clear errors", async () => {
    const file = encodeImpostor(make(["base", "normalDepth", "orm"]));
    const pending: Promise<unknown>[] = [];
    const bad = (input: Uint8Array, pattern: RegExp) => pending.push(expect(decodeImpostorAsync(input)).rejects.toThrow(pattern));
    bad(new Uint8Array(64), /Invalid impostor file: not a KTX2 container/);
    bad(file.subarray(0, 40), /Invalid impostor file: not a KTX2 container/);
    bad(file.subarray(0, file.length - 200), /Invalid impostor file/);

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
});

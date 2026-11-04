import { RGBAFormat } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { decodeImpostorAsync, encodeImpostorAsync } from "../../src/impostor/codec.js";
import type { Impostor, ImpostorMap } from "../../src/impostor/impostor.js";

/** An atlas of smooth gradients, as baked maps are, `size` square with `frames` per side. */
function make(maps: ImpostorMap[], size = 64, frames = 8): Impostor {
  const level = (width: number, i: number) => {
    const data = new Uint8Array(width * width * 4);
    for (let y = 0; y < width; y++)
      for (let x = 0; x < width; x++) data.set([(x * 255) / width, (y * 255) / width, i * 60, 255 - (x * 128) / width], (y * width + x) * 4);
    return data;
  };
  return {
    version: 4,
    layout: "hemi",
    frames,
    size,
    box: [-1, 0, -0.5, 1, 2.25, 0.5],
    halfSize: 1.6,
    maps,
    layers: maps.map((_, i) => ({ format: RGBAFormat, mipmaps: Array.from({ length: Math.log2(size / frames) + 1 }, (_, m) => level(size >> m, i)) })),
  };
}

describe("impostor codec", () => {
  it("keeps the metadata and transcodes every map's baked levels to one GPU format", async () => {
    const source = make(["base", "normalDepth", "orm", "emissive"]);
    source.specular = [0.03, 0.06, 0.08, 1];
    const { layers: _, ...meta } = source;
    const file = await encodeImpostorAsync(source);
    const padded = new Uint8Array(file.length + 17);
    padded.set(file, 17);
    const decoded = await decodeImpostorAsync(padded.subarray(17));
    const { layers, ...decodedMeta } = decoded;
    expect(decodedMeta).toEqual(meta);
    expect(layers.map((layer) => layer.mipmaps.length)).toEqual([4, 4, 4, 4]);
    // Every WebGPU device the tests run on takes BC, ASTC or ETC2 blocks.
    expect(new Set(layers.map((layer) => layer.format)).size).toBe(1);
    expect(layers[0]?.format).not.toBe(RGBAFormat);
    // A decoded impostor holds blocks, which only a bake's texels encode from.
    await expect(encodeImpostorAsync(decoded)).rejects.toThrow(/encode a baked impostor/);
  });

  it("rejects corrupt and truncated files", async () => {
    const file = await encodeImpostorAsync(make(["base", "normalDepth", "orm"]));
    const flipped = file.slice();
    flipped[file.length >> 1] = (flipped[file.length >> 1] ?? 0) ^ 0x10;
    await expect(decodeImpostorAsync(flipped)).rejects.toThrow(/Invalid impostor file: corrupt/);
    await expect(decodeImpostorAsync(file.subarray(0, file.length - 9))).rejects.toThrow(/Invalid impostor file: corrupt/);
    await expect(decodeImpostorAsync(new Uint8Array(64))).rejects.toThrow(/Invalid impostor file/);
  });
});

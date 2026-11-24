import type { Encoder } from "gputex";
import type { Renderer } from "three/webgpu";
import type { BlockFormat } from "./index.js";

// Encoding maps to blocks with gputex's compute shaders, on the device of the renderer that baked them.

/** gputex's encoders per device, one per format, each made and compiled at its first encode. */
const encoders = new WeakMap<GPUDevice, Map<BlockFormat, Promise<Encoder>>>();

/**
 * RGBA8 mip levels `size >> level` square as blocks of `format`, every level in one compute pass on `renderer`'s device.
 * A level smaller than a block is padded as the GPU samples it, clamped to its edge.
 */
export async function encodeBlocks(renderer: Renderer, format: BlockFormat, levels: readonly Uint8Array[], size: number): Promise<Uint8Array[]> {
  const { padToBlockMultiple } = await import("gputex");
  const encoder = await encoderOf(deviceOf(renderer), format);
  const chain = levels.map((data, m) => {
    const side = Math.max(1, size >> m);
    return padToBlockMultiple({ data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: side, height: side });
  });
  const { levels: encoded } = await inOrder(encoder, () => encoder.encodeMipChainToBytes(chain));
  return encoded.map(({ data }) => data);
}

/** Each encoder's encodes, run one at a time: an encoder reads back through staging buffers of its own. */
const queues = new WeakMap<Encoder, Promise<unknown>>();

function inOrder<T>(encoder: Encoder, encode: () => Promise<T>): Promise<T> {
  const next = (queues.get(encoder) ?? Promise.resolve()).then(encode);
  // The queue goes on past a failed encode; its caller has the failure.
  queues.set(
    encoder,
    next.catch(() => {}),
  );
  return next;
}

function encoderOf(device: GPUDevice, format: BlockFormat): Promise<Encoder> {
  let made = encoders.get(device);
  if (!made) encoders.set(device, (made = new Map()));
  let encoder = made.get(format);
  if (!encoder) {
    encoder = import("gputex").then(({ BC7Encoder, ASTC4x4Encoder }) => (format === "bc7" ? new BC7Encoder({ device }) : new ASTC4x4Encoder({ device })));
    made.set(format, encoder);
  }
  return encoder;
}

/** The GPUDevice a WebGPURenderer draws with, which three's backend types leave out. */
function deviceOf(renderer: Renderer): GPUDevice {
  const device: unknown = Reflect.get(renderer.backend, "device");
  if (!isDevice(device)) throw new Error("@drawcall/lod: maps encode on a WebGPURenderer's device; initialise one with WebGPU");
  return device;
}

const isDevice = (value: unknown): value is GPUDevice => typeof value === "object" && value !== null && "queue" in value && "createComputePipeline" in value;

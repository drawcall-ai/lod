import { Color, DataUtils, WebGPURenderer, type RenderTarget, type Renderer } from "three/webgpu";

// The GPU side of bakes: impostor frames and interior rooms render here.

let shared: Promise<WebGPURenderer> | undefined;

/**
 * The package's own renderer for bakes, made once and initialised. Its canvas is never
 * drawn to: three applies a render target's viewport only when it differs from the
 * canvas's size, and the bakes place their frames by viewport.
 */
export function sharedRenderer(): Promise<WebGPURenderer> {
  shared ??= (async () => {
    const renderer = new WebGPURenderer({ antialias: false });
    await renderer.init();
    return renderer;
  })();
  return shared;
}

/**
 * Point `renderer` at `target`, without the app's XR camera, MRT or clear colour, and
 * return a function that puts the app's state back. A bake holds a renderer for one
 * synchronous run of renders: the app keeps rendering while the bake awaits.
 */
export function borrow(renderer: Renderer, target: RenderTarget): () => void {
  const previous = {
    target: renderer.getRenderTarget(),
    clear: renderer.getClearColor(new Color()),
    alpha: renderer.getClearAlpha(),
    autoClear: renderer.autoClear,
    xr: renderer.xr.enabled,
    mrt: renderer.getMRT(),
  };
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  renderer.xr.enabled = false;
  renderer.setMRT(null);
  return () => {
    renderer.setRenderTarget(previous.target);
    renderer.setClearColor(previous.clear, previous.alpha);
    renderer.autoClear = previous.autoClear;
    renderer.xr.enabled = previous.xr;
    renderer.setMRT(previous.mrt);
  };
}

/**
 * Texture `index` of `target` as floats, four channels a texel, rows packed and bottom
 * row first: the layout the bakes write their images in. For float and half-float
 * targets.
 */
export async function readFloats(renderer: Renderer, target: RenderTarget, index: number): Promise<Float32Array> {
  const read = await renderer.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height, index);
  if (read instanceof Float32Array) return packed(read, target, (n) => new Float32Array(n));
  // Half floats come back as their bits.
  if (read instanceof Uint16Array) return fromHalves(packed(read, target, (n) => new Uint16Array(n)));
  throw new Error(`@drawcall/lod: read ${read.constructor.name} from a float render target`);
}

/** Texture `index` of an 8-bit `target`, laid out as `readFloats` lays it out. */
export async function readBytes(renderer: Renderer, target: RenderTarget, index: number): Promise<Uint8Array> {
  const read = await renderer.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height, index);
  if (!(read instanceof Uint8Array)) throw new Error(`@drawcall/lod: read ${read.constructor.name} from an 8-bit render target`);
  return packed(read, target, (n) => new Uint8Array(n));
}

/** Every half float by its bits. */
const HALF = Float32Array.from({ length: 65536 }, (_, bits) => DataUtils.fromHalfFloat(bits));

function fromHalves(bits: Uint16Array): Float32Array {
  const out = new Float32Array(bits.length);
  // Typed-array reads below are in bounds; `?? 0` only answers noUncheckedIndexedAccess.
  for (let i = 0; i < bits.length; i++) out[i] = HALF[bits[i] ?? 0] ?? 0;
  return out;
}

/** `read`'s rows, each padded to 256 bytes and top first, packed and bottom first. */
function packed<T extends Float32Array | Uint16Array | Uint8Array>(read: T, { width, height }: RenderTarget, make: (length: number) => T): T {
  const row = width * 4;
  const stride = (Math.ceil((row * read.BYTES_PER_ELEMENT) / 256) * 256) / read.BYTES_PER_ELEMENT;
  const out = make(row * height);
  for (let y = 0; y < height; y++) out.set(read.subarray(y * stride, y * stride + row), (height - 1 - y) * row);
  return out;
}

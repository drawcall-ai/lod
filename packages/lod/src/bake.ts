import { Color, DataUtils, WebGPURenderer, type RenderTarget, type Renderer } from "three/webgpu";

// What the GPU bakes (impostor frames, interior rooms) share: the renderer they draw with, one bake at a time on it,
// and reading back what they drew.

/**
 * A renderer for bakes, initialised: it clears to transparent black, only when a bake clears, and its canvas is never
 * shown or sized. Pass it to `bakeImpostor`, or to `bakeMesh` with an interior, and dispose it when done. LodLoader
 * makes one for itself; so does a .glts script that bakes.
 */
export async function createBakeRenderer(): Promise<WebGPURenderer> {
  const renderer = new WebGPURenderer({ antialias: false });
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  await renderer.init();
  return renderer;
}

/**
 * Throw unless `renderer` draws bakes as `createBakeRenderer` sets one up: initialised, clearing to transparent black
 * and only when told to, with no MRT or XR camera of its own. A bake draws through every such setting; `who` names it.
 */
export function checkBakeRenderer(renderer: Renderer, who: string): void {
  const fail = (why: string) => {
    throw new Error(`${who}: the renderer ${why}; make one for bakes with createBakeRenderer`);
  };
  if (!renderer.initialized) fail("is not initialised (await renderer.init())");
  if (!renderer.getClearColor(new Color()).equals(BLACK) || renderer.getClearAlpha() !== 0) fail("must clear to transparent black");
  if (renderer.autoClear) fail("must not clear on its own (autoClear)");
  if (renderer.getMRT() !== null) fail("has an MRT set");
  if (renderer.xr.isPresenting) fail("is presenting XR");
}

const BLACK = new Color(0x000000);

/**
 * The bake under way on each renderer and those queued after it. Bakes run one at a time on a renderer: each holds one
 * target's renders in flight, and a scene's bakes all at once queued GPU work seconds deep (macOS ends a device whose
 * work holds the display up). A side table, as the renderers are the caller's.
 */
const queues = new WeakMap<Renderer, Promise<unknown>>();

/** Run `bake` on `renderer` once every bake queued on it before has settled. */
export function inTurn<T>(renderer: Renderer, bake: () => Promise<T>): Promise<T> {
  const next = (queues.get(renderer) ?? Promise.resolve()).then(bake);
  // The queue goes on past a failed bake; its caller has the failure.
  queues.set(
    renderer,
    next.catch(() => {}),
  );
  return next;
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

/** Every half float by its bits: an immutable table, made once. */
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

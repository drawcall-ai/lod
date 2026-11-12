import { Color, DataUtils, Group, InstancedMesh, Matrix4, WebGPURenderer, type Object3D, type RenderTarget, type Renderer } from "three/webgpu";
import { disposeCopies } from "./dispose.js";
import type { Lod } from "./lod.js";
import { isLod, isMesh } from "./three.js";

// What the GPU bakes (impostor frames, interior rooms) share: the renderer they draw with, one bake at a time on it,
// and reading back what they drew.

/**
 * A renderer for bakes, initialised: it clears to transparent black, only when a bake clears, and its canvas is never
 * shown or sized. Pass it to `bakeImpostor`, or to `bakeMesh` with an interior, and dispose it when done. CachedLodLoader
 * makes one for itself; so does a .glts script that bakes.
 */
export function createBakeRenderer(): Promise<WebGPURenderer> {
  return setUpBakeRenderer(new WebGPURenderer({ antialias: false }));
}

/** `renderer`, made without antialiasing, set up and initialised as `createBakeRenderer` sets one up. */
export async function setUpBakeRenderer(renderer: WebGPURenderer): Promise<WebGPURenderer> {
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

/** A copy of what a bake draws, and what frees it once drawn. */
export interface BakeCopy {
  readonly root: Object3D;
  /** Free what the copy made: its InstancedMeshes' buffers and every Lod's draw state. */
  dispose(): void;
}

/**
 * `root`, a fresh copy of what a bake draws, each Lod in it drawn as plain InstancedMeshes of its level 0 at every
 * instance: a Lod draws with the renderer that first drew it, the app's, and nothing in its first frame.
 */
export function bakeCopy(root: Object3D): BakeCopy {
  const lods: Lod[] = [];
  root.traverse((node) => {
    if (isLod(node)) lods.push(node);
  });
  let copy = root;
  for (const lod of lods) {
    const drawn = levelZero(lod);
    // Only the root has no parent here.
    const { parent } = lod;
    if (parent) parent.add(drawn);
    else copy = drawn;
    lod.removeFromParent();
    lod.dispose();
  }
  return { root: copy, dispose: () => disposeCopies(copy) };
}

/**
 * `lod`'s level 0 as a Group in its place, an InstancedMesh per visible mesh of the level drawing it at every instance,
 * coloured as the instances are; empty while the level is not loaded. The CPU reads the instances: storage attributes
 * cannot be baked.
 */
function levelZero(lod: Lod): Group {
  const group = new Group();
  group.name = lod.name;
  group.position.copy(lod.position);
  group.quaternion.copy(lod.quaternion);
  group.scale.copy(lod.scale);
  group.matrixAutoUpdate = lod.matrixAutoUpdate;
  group.matrix.copy(lod.matrix);
  group.visible = lod.visible;
  group.layers.mask = lod.layers.mask;
  const source = lod.levels[0]?.object;
  if (!source) return group;
  source.updateWorldMatrix(true, true);
  const outside = source.parent ? source.parent.matrixWorld.clone().invert() : new Matrix4();
  const instance = new Matrix4();
  const color = new Color();
  source.traverseVisible((node) => {
    if (!isMesh(node)) return;
    const placement = outside.clone().multiply(node.matrixWorld);
    const mesh = new InstancedMesh(node.geometry, node.material, lod.count);
    for (let i = 0; i < lod.count; i++) {
      mesh.setMatrixAt(i, lod.getMatrixAt(i, instance).multiply(placement));
      if (lod.instanceColor) mesh.setColorAt(i, lod.getColorAt(i, color));
    }
    mesh.name = node.name;
    mesh.castShadow = node.castShadow;
    mesh.receiveShadow = node.receiveShadow;
    group.add(mesh);
  });
  return group;
}

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

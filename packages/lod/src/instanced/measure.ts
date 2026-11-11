import { Matrix4, Vector3, type Sphere } from "three/webgpu";
import { d, std, tgpu } from "typegpu";
import { drawnLevel, levelsToDraw } from "../levels/draw.js";
import type { LocalCamera } from "./camera.js";
import type { Cull } from "./cull.js";

// How one instance draws, the same on the CPU and in the sort (see update.ts): whether cullDistance thins it out and
// how much its survivors grow, and its height on screen.

/** The largest a survivor of `cullDistance` grows: what it reaches where 1/64 of the instances draw. */
export const MAX_SURVIVOR_SCALE = 8;

/** Three xorshift steps: shifts and xors only, exact in JavaScript's 32-bit integer operators as on the GPU. */
const xorshift = tgpu.fn(
  [d.u32],
  d.u32,
)((value) => {
  "use gpu";
  let h = d.u32(value);
  h = d.u32(h ^ (h << 13));
  h = d.u32(h ^ (h >>> 17));
  h = d.u32(h ^ (h << 5));
  return h;
});

/**
 * The bits of `origin`, an instance's translation, hashed into [0, 1): what thins it out (see `CullDistance`), the
 * same on the CPU and the GPU.
 */
export const originHash = tgpu.fn(
  [d.vec3f],
  d.f32,
)((origin) => {
  "use gpu";
  const bits = std.bitcastF32toU32(origin);
  let h = xorshift(bits.x ^ d.u32(0x9e3779b9));
  h = xorshift(h ^ bits.y);
  h = xorshift(h ^ bits.z);
  h = xorshift(h);
  return d.f32(h >>> 8) / 16777216;
});

/**
 * How an instance at `origin`, `distance` from the cullDistance camera, draws (see `CullDistance`): 0 thinned out,
 * else the scale it draws at: 1, or with `survivors` 1/√share, share the share of instances drawn at its distance.
 */
export const cullScale = tgpu.fn(
  [d.vec3f, d.f32, d.f32, d.f32, d.u32],
  d.f32,
)((origin, distance, near, far, survivors) => {
  "use gpu";
  const share = std.clamp((far - distance) / (far - near), 0, 1);
  if (originHash(origin) >= share) return 0;
  if (survivors === 0) return 1;
  return std.min(1 / std.sqrt(share), MAX_SURVIVOR_SCALE);
});

/** The longest `matrix` scales an axis. */
const longestAxis = tgpu.fn(
  [d.mat4x4f],
  d.f32,
)((matrix) => {
  "use gpu";
  const x = std.length(std.mul(matrix, d.vec4f(1, 0, 0, 0)).xyz);
  const y = std.length(std.mul(matrix, d.vec4f(0, 1, 0, 0)).xyz);
  const z = std.length(std.mul(matrix, d.vec4f(0, 0, 1, 0)).xyz);
  return std.max(x, std.max(y, z));
});

/**
 * Where an instance at `matrix` stands for a camera, `source` the source's sphere (centre, radius) grown by `grow`:
 * the source's centre (xyz), and its height on screen (w) seen from `eye` with `scale` pixels per unit of subtense, or
 * of size with `ortho` 1, as a Lod measures its own on the CPU (see screen.ts: 2 r q / d).
 */
export const instanceOnScreen = tgpu.fn(
  [d.mat4x4f, d.vec4f, d.f32, d.vec3f, d.f32, d.u32],
  d.vec4f,
)((matrix, source, grow, eye, scale, ortho) => {
  "use gpu";
  const centre = std.mul(matrix, d.vec4f(std.mul(source.xyz, grow), 1)).xyz;
  const size = source.w * longestAxis(matrix) * grow * 2 * scale;
  if (ortho === 1) return d.vec4f(centre, size);
  return d.vec4f(centre, size / std.max(std.distance(centre, eye), 1e-6));
});

const instance = new Matrix4();
const origin = new Vector3();

const toVec3f = ({ x, y, z }: Vector3) => d.vec3f(x, y, z);

/**
 * The level the instance at `offset` of `matrices` draws most of its pixels with (see `InstancedLodCpuChunk.getLevelAt`),
 * thinned out by `cull` and seen by `camera`, both in the InstancedLod's space, of the levels of `loaded`, `source` the
 * source's sphere; null if it draws nothing.
 */
export function instanceLevel(
  matrices: ArrayLike<number>,
  offset: number,
  cull: Cull | null,
  camera: LocalCamera,
  source: Sphere,
  loaded: number,
): number | null {
  instance.fromArray(matrices, offset);
  if (instance.getMaxScaleOnAxis() === 0) return null;
  origin.setFromMatrixPosition(instance);
  const grow = cull ? cullScale(toVec3f(origin), origin.distanceTo(cull.eye), cull.near, cull.far, Number(cull.survivors)) : 1;
  if (grow === 0) return null;
  const { levels, eye, scale, ortho } = camera;
  const { center, radius } = source;
  const height = instanceOnScreen(d.mat4x4f(...instance.elements), d.vec4f(center.x, center.y, center.z, radius), grow, toVec3f(eye), scale, Number(ortho)).w;
  return drawnLevel(levelsToDraw(height, levels, loaded, loaded, 1));
}

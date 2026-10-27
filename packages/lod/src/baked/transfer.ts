import { Box3, Matrix3, Vector3 } from "three/webgpu";
import { pause } from "../pause.js";
import { tangentFrame } from "../source/frame.js";
import { Shading } from "../source/shading.js";
import type { Source } from "../source/source.js";
import { linearToSrgb } from "../source/texels.js";
import { Tracer } from "../source/trace.js";
import { roomAlong, windowDepth } from "./interior/rooms.js";
import type { Low } from "./low.js";

/** The baked maps, RGBA8 each, row 0 at v = 0. */
interface Maps {
  /** sRGB base colour; alpha 255 where the surface is, 0 where it is cut out */
  color: Uint8ClampedArray;
  /** tangent-space normal, in the frame three derives from the low mesh's UVs */
  normal: Uint8ClampedArray;
  /** R occlusion, G roughness, B metalness */
  orm: Uint8ClampedArray;
  /**
   * RG8: R the room behind the nearest window texel + 1 (0 without rooms), G the share of
   * a window texel through which its room shows (0 elsewhere)
   */
  windows: Uint8Array;
}

/**
 * What a texel became: no low triangle covers it, a surface was baked, or its ray found
 * no surface (cut out where the source cuts out, else its neighbours' colour).
 */
const EMPTY = 0;
const BAKED = 1;
const OPEN = 2;

/**
 * Transfer `source`'s surface onto `low`'s texels. For each covered texel, a ray is cast
 * from P + reach·N to P - reach·N (N the smoothed low normal) against the source; the
 * first hit that is opaque and faces the same way as the low triangle (or is on a
 * double-sided material) is shaded. With none, the ray goes on through the whole source:
 * over open sources such as a canopy of leaves it finds the leaves lower down that a
 * viewer sees through the gap. A texel whose ray finds nothing at all is open: cut out if
 * the source cuts out anywhere, as the source shows nothing there either, else (an
 * opaque low mesh cannot show a hole) coloured like its neighbours. The nearest source
 * point would be the wrong colour there: over a canopy it is whatever stands highest,
 * such as the tassels of corn, which then cover the bake in pale blobs. Texels no surface
 * was baked into are filled from their neighbours, so filtering and mips do not pull in
 * black at chart edges.
 *
 * With room `boxes`, a texel whose surface is glass is a window into the room the ray
 * enters after passing it (see `windowDepth`).
 */
export async function transfer(source: Source, low: Low, reach: number, texelSize: number, boxes: readonly Box3[] | null): Promise<Maps> {
  const { size, triangles, weights } = low.raster;
  const count = size * size;
  const color = new Uint8ClampedArray(count * 4);
  const normal = new Uint8ClampedArray(count * 4);
  const orm = new Uint8ClampedArray(count * 4);
  const state = new Uint8Array(count);
  const windows = new Uint8Array(count * 2);
  const depth = boxes ? windowDepth(boxes) : 0;
  const hit = new Vector3();
  const shading = new Shading(source, texelSize);
  const tracer = new Tracer(source, shading);
  const P = new Vector3();
  const N = new Vector3();
  const F = new Vector3();
  const R = new Vector3();
  const origin = new Vector3();
  const direction = new Vector3();
  const e1 = new Vector3();
  const e2 = new Vector3();
  const tangent = new Vector3();
  const bitangent = new Vector3();
  const frame = new Matrix3();
  const local = new Vector3();
  // Far enough to pass through the whole source from anywhere on the low mesh.
  const through = 2 * reach + source.bvh.getBoundingBox(new Box3()).getSize(new Vector3()).length();
  const { positions, normals, uvs, index } = low;
  let w0 = 0;
  let w1 = 0;
  let w2 = 0;
  let a = 0;
  let b = 0;
  let c = 0;
  const lerp = (array: Float32Array, k: number) => (array[a * 3 + k] ?? 0) * w0 + (array[b * 3 + k] ?? 0) * w1 + (array[c * 3 + k] ?? 0) * w2;
  const edge = (to: number, k: number) => (positions[to * 3 + k] ?? 0) - (positions[a * 3 + k] ?? 0);
  const uv = (corner: number, k: number) => uvs[corner * 2 + k] ?? 0;

  let yielded = performance.now();
  for (let texel = 0; texel < count; texel++) {
    if ((texel & 1023) === 0 && performance.now() - yielded > 30) {
      await pause();
      yielded = performance.now();
    }
    const triangle = triangles[texel] ?? -1;
    if (triangle < 0) continue;
    a = index[triangle * 3] ?? 0;
    b = index[triangle * 3 + 1] ?? 0;
    c = index[triangle * 3 + 2] ?? 0;
    w1 = weights[texel * 2] ?? 0;
    w2 = weights[texel * 2 + 1] ?? 0;
    w0 = 1 - w1 - w2;
    P.set(lerp(positions, 0), lerp(positions, 1), lerp(positions, 2));
    N.set(lerp(normals, 0), lerp(normals, 1), lerp(normals, 2)).normalize();
    e1.set(edge(b, 0), edge(b, 1), edge(b, 2));
    e2.set(edge(c, 0), edge(c, 1), edge(c, 2));
    F.crossVectors(e1, e2).normalize();
    // Rays follow the smoothed normal, so creases leave no gaps, unless smoothing broke
    // down (back-to-back cards welded). Which side faces out is the low triangle's.
    R.copy(N.dot(F) > 0.2 ? N : F);
    origin.copy(P).addScaledVector(R, reach);
    direction.copy(R).negate();
    // From outside in: the outermost surface is what a viewer sees of the source here.
    if (tracer.cast(origin, direction, through, F) !== "opaque") {
      state[texel] = OPEN;
      continue;
    }
    shading.shade(tracer.triangle, tracer.w1, tracer.w2, false);
    const { transmittance } = shading.material(tracer.triangle);
    if (boxes && transmittance > 0) {
      const room = roomAlong(boxes, pointOf(source, tracer.triangle, tracer.w1, tracer.w2, hit), direction, depth);
      if (room >= 0) {
        windows[texel * 2] = room + 1;
        windows[texel * 2 + 1] = Math.round(transmittance * 255);
      }
    }
    state[texel] = BAKED;
    const o = texel * 4;
    color[o] = linearToSrgb(shading.r) * 255;
    color[o + 1] = linearToSrgb(shading.g) * 255;
    color[o + 2] = linearToSrgb(shading.b) * 255;
    orm[o] = shading.ao * 255;
    orm[o + 1] = shading.roughness * 255;
    orm[o + 2] = shading.metalness * 255;
    // The normal in the frame three will rebuild here from the mesh's own normal: solve
    // (T B N) · m = n for m.
    tangentFrame(e1, e2, uv(b, 0) - uv(a, 0), uv(b, 1) - uv(a, 1), uv(c, 0) - uv(a, 0), uv(c, 1) - uv(a, 1), N, tangent, bitangent);
    frame.set(tangent.x, bitangent.x, N.x, tangent.y, bitangent.y, N.y, tangent.z, bitangent.z, N.z);
    if (frame.determinant() === 0) local.set(0, 0, 1);
    else local.copy(shading.normal).applyMatrix3(frame.invert()).normalize();
    normal[o] = (local.x * 0.5 + 0.5) * 255;
    normal[o + 1] = (local.y * 0.5 + 0.5) * 255;
    normal[o + 2] = (local.z * 0.5 + 0.5) * 255;
  }

  // Colours spread over everything not baked, open texels included, so coverage edges
  // do not fringe; coverage spreads only into texels no triangle covers.
  dilate(state, (texel) => texel === BAKED, [color, normal, orm], 0, 3, size);
  for (let texel = 0; texel < count; texel++) color[texel * 4 + 3] = state[texel] === BAKED ? 255 : 0;
  if (source.cutout) {
    dilate(state, (texel) => texel !== EMPTY, [color], 3, 1, size);
    // Coverage stays a decision: in or out, at 0.5.
    for (let i = 3; i < color.length; i += 4) color[i] = (color[i] ?? 0) >= 128 ? 255 : 0;
  } else for (let i = 3; i < color.length; i += 4) color[i] = 255;
  for (let i = 3; i < color.length; i += 4) normal[i] = orm[i] = 255;
  spreadRooms(windows, size);
  return { color, normal, orm, windows };
}

/**
 * Give every texel of `windows` without a room the room of the nearest one with (by
 * 4-neighbour steps): the share filters across window edges and mip levels, and wherever
 * it does the texel read there must name the window's room.
 */
function spreadRooms(windows: Uint8Array, size: number): void {
  let ring: number[] = [];
  for (let i = 0; i < size * size; i++) if (windows[i * 2]) ring.push(i);
  while (ring.length > 0) {
    const next: number[] = [];
    for (const i of ring) {
      const x = i % size;
      const room = windows[i * 2] ?? 0;
      for (const j of [x > 0 ? i - 1 : -1, x < size - 1 ? i + 1 : -1, i - size, i + size]) {
        if (j < 0 || j >= size * size || windows[j * 2]) continue;
        windows[j * 2] = room;
        next.push(j);
      }
    }
    ring = next;
  }
}

/** The point at weights (`w1`, `w2`) of `source`'s triangle `triangle`, into `out`. */
function pointOf({ positions, index }: Source, triangle: number, w1: number, w2: number, out: Vector3): Vector3 {
  const corner = (k: number, c: number) => positions[(index[triangle * 3 + k] ?? 0) * 3 + c] ?? 0;
  return out.set(
    corner(0, 0) * (1 - w1 - w2) + corner(1, 0) * w1 + corner(2, 0) * w2,
    corner(0, 1) * (1 - w1 - w2) + corner(1, 1) * w1 + corner(2, 1) * w2,
    corner(0, 2) * (1 - w1 - w2) + corner(1, 2) * w1 + corner(2, 2) * w2,
  );
}

/**
 * Fill every texel `known` rejects with the mean of its known 8 neighbours, ring by ring
 * outwards until the whole texture is filled: `channels` channels from `first` of each
 * layer.
 */
function dilate(state: Uint8Array, known: (state: number) => boolean, layers: Uint8ClampedArray[], first: number, channels: number, size: number): void {
  const done = new Uint8Array(state.length);
  const queued = new Uint8Array(state.length);
  let ring = new Int32Array(state.length);
  let next = new Int32Array(state.length);
  let length = 0;
  for (let i = 0; i < state.length; i++) done[i] = known(state[i] ?? EMPTY) ? 1 : 0;
  const enqueue = (i: number) => {
    const x = i % size;
    const y = (i - x) / size;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = ny * size + nx;
        if (done[j] || queued[j]) continue;
        queued[j] = 1;
        next[length++] = j;
      }
  };
  for (let i = 0; i < state.length; i++) if (done[i]) enqueue(i);
  while (length > 0) {
    [ring, next] = [next, ring];
    const count = length;
    length = 0;
    for (let r = 0; r < count; r++) {
      const i = ring[r] ?? 0;
      const x = i % size;
      const y = (i - x) / size;
      for (const layer of layers)
        for (let c = first; c < first + channels; c++) {
          let sum = 0;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
              const j = ny * size + nx;
              if (!done[j]) continue;
              sum += layer[j * 4 + c] ?? 0;
              n++;
            }
          if (n > 0) layer[i * 4 + c] = sum / n;
        }
    }
    // A ring becomes a source only for the next one.
    for (let r = 0; r < count; r++) done[ring[r] ?? 0] = 1;
    for (let r = 0; r < count; r++) enqueue(ring[r] ?? 0);
  }
}

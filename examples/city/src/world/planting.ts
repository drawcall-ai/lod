// The compute passes that plant forests and ground cover in the tiles near the camera. A stand's tiles hold spots on a
// jittered grid, which its plantings share out in fixed numbers: each planting takes the spots a shuffled list gives
// it, turned along by a tile's hash, so that tiles differ and a tile planted again shows the same plants. A spot's hash
// gives how large its plant grows, how it turns and its tint. Each planting writes its spots into its slot of a range
// of its asset's instances (see Scatter.take): the finished instance where the spot grows one, a matrix of scale 0
// (no instance) elsewhere.
import * as t3 from "@typegpu/three";
import seedrandom from "seedrandom";
import { Fn, instanceIndex, storage, uint, vec4 } from "three/tsl";
import * as THREE from "three/webgpu";
import { d, std } from "typegpu";
import { reach } from "./bounds.ts";
import type { Plan } from "./plan.ts";
import { NearTiles, tileAt, tileKey, tilesAround } from "./near-tiles.ts";
import type { Range, Scatter } from "./scatter.ts";
import type { Use } from "./land.ts";
import { CELL, EXTENT } from "./terrain.ts";

/** Tiles planted per frame. */
const PER_FRAME = 4;
/** Metres a tile's box of origins reaches beyond the ground's heights under it. */
const SLACK = 1;

/** A u32 mixed so that each bit depends on all of them. */
function scramble(x: number): number {
  "use gpu";
  let h = d.u32(x);
  h = (h ^ (h >>> 16)) * d.u32(0x85ebca6b);
  h = (h ^ (h >>> 13)) * d.u32(0xc2b2ae35);
  return h ^ (h >>> 16);
}

/** Plants on a jittered grid in the tiles near the camera. */
export interface Stand {
  name: string;
  /** Edge of a tile (m). */
  tile: number;
  /** Plants per square metre, before `ground` and `grows`. */
  density: number;
  /** How far from the camera they are held (m). */
  radius: number;
  /** The land they grow on. */
  ground: Use;
  /** Where on that land they grow, by a cell's centre; everywhere without. */
  grows?: (x: number, z: number) => boolean;
}

/**
 * What a stand plants of one asset: its `share` of the spots (the shares adding up to 1), scaled within `scale` and,
 * when `tinted`, a little lighter or darker, yellower or bluer; with a `color`, coloured by it at each spot's x, z.
 */
export type Planting = {
  url: string;
  share: number;
  scale: readonly [number, number];
} & ({ tinted?: boolean; color?: never } | { color: (xz: THREE.Node<"vec2">) => THREE.Node<"vec3">; tinted?: never });

/** Plants stands on `plan`'s ground, whose heights its passes, run on `renderer`, share on the GPU, into `scatter`'s assets. */
export function planter(plan: Plan, scatter: Scatter, renderer: THREE.Renderer) {
  const { heights } = plan.terrain;
  const ground = t3.instancedArray(heights, d.f32);
  const cells = Math.sqrt(heights.length) - 1;

  const groundAt = (i: number, j: number): number => {
    "use gpu";
    return d.f32(ground.$[d.u32(j) * d.u32(cells + 1) + d.u32(i)]);
  };

  /** Exactly on the drawn mesh, as `Terrain.height`: each cell is split along its diagonal from (i, j + 1) to (i + 1, j). */
  const heightAt = (x: number, z: number): number => {
    "use gpu";
    const u = (x + EXTENT) / CELL;
    const v = (z + EXTENT) / CELL;
    if (u < 0 || v < 0 || u >= cells || v >= cells) return 0;
    const i = std.floor(u);
    const j = std.floor(v);
    const fx = u - i;
    const fz = v - j;
    if (fx + fz <= 1) {
      const h00 = groundAt(i, j);
      return h00 + (groundAt(i + 1, j) - h00) * fx + (groundAt(i, j + 1) - h00) * fz;
    }
    const h11 = groundAt(i + 1, j + 1);
    return h11 + (groundAt(i, j + 1) - h11) * (1 - fx) + (groundAt(i + 1, j) - h11) * (1 - fz);
  };

  /** The tiles of `stand` near the camera, planted with `plantings`, whose instances it takes before `scatter` seals. */
  return async (stand: Stand, plantings: readonly Planting[]): Promise<NearTiles> => {
    const { tile, density, radius, ground: use, grows } = stand;
    const { size: side, cells: uses } = plan.land;
    const raster = (2 * EXTENT) / side;
    const growth = new Uint32Array(Math.ceil((side * side) / 32));
    const holding = new Set<number>();
    // cells along a row fall in the same tile: add a tile once per run of them
    let held = NaN;
    for (let k = 0; k < uses.length; k++) {
      if (uses[k] !== use) continue;
      const x = -EXTENT + ((k % side) + 0.5) * raster;
      const z = -EXTENT + (Math.floor(k / side) + 0.5) * raster;
      if (grows && !grows(x, z)) continue;
      growth[k >>> 5] = (growth[k >>> 5] ?? 0) | (1 << (k & 31));
      const key = tileKey(Math.floor(x / tile), Math.floor(z / tile));
      if (key !== held) holding.add((held = key));
    }

    const perSide = Math.max(1, Math.round(tile * Math.sqrt(density)));
    const capacity = perSide * perSide;
    const spacing = tile / perSide;
    const room = Math.min(Math.ceil((Math.PI * (radius + tile) ** 2) / (tile * tile)), holding.size);
    const growing = t3.instancedArray(growth, d.u32);
    const tileId = t3.uniform(0, d.u32);
    const turn = t3.uniform(0, d.u32);
    const x0 = t3.uniform(0, d.f32);
    const z0 = t3.uniform(0, d.f32);
    const slot = t3.uniform(0, d.u32);

    const growsAt = (x: number, z: number): boolean => {
      "use gpu";
      const u = (x + EXTENT) / raster;
      const v = (z + EXTENT) / raster;
      if (u < 0 || v < 0 || u >= side || v >= side) return false;
      const k = d.u32(v) * d.u32(side) + d.u32(u);
      return ((d.u32(growing.$[k >>> 5]) >>> (k & 31)) & 1) === 1;
    };

    /** The passes that plant a tile's `spots` of `planting` into slot `slot` of `range`. */
    const pass = ({ scale: [low, high], tinted = false, color }: Planting, spots: Uint32Array, range: Range) => {
      const { instanceMatrix: matrices, instanceColor: colors } = range.node;
      if (!(matrices instanceof THREE.StorageInstancedBufferAttribute && colors instanceof THREE.StorageInstancedBufferAttribute))
        throw new Error(`${stand.name}: plant once its Scatter has sealed, into storage instances`);
      const matrixAt = t3.fromTSL(storage(matrices, "mat4", matrices.count), d.arrayOf(d.mat4x4f));
      const colorAt = t3.fromTSL(storage(colors, "vec4", colors.count), d.arrayOf(d.vec4f));
      const spotAt = t3.instancedArray(spots, d.u32);
      const count = spots.length;
      const { start } = range;
      const vary = tinted ? 1 : 0;
      const plant = t3
        .toTSL(() => {
          "use gpu";
          const j = t3.instanceIndex.$;
          const at = start + slot.$ * count + j;
          // no instance, unless this spot plants one
          matrixAt.$[at] = d.mat4x4f();
          const k = (d.u32(spotAt.$[j]) + turn.$) % capacity;
          const hash = scramble(tileId.$ + k * d.u32(0x9e3779b9));
          const seed = hash | 1;
          const looks = scramble(seed);
          const jitter = scramble(hash);
          const x = x0.$ + (d.f32(k % perSide) + d.f32(jitter & 0xffff) / 65536) * spacing;
          const z = z0.$ + (d.f32(std.intdiv(k, perSide)) + d.f32(jitter >>> 16) / 65536) * spacing;
          if (!growsAt(x, z)) return;
          const size = low + ((high - low) * d.f32(looks >>> 16)) / 65536;
          const angle = (d.f32(seed >>> 16) / 65536) * 2 * Math.PI;
          const c = std.cos(angle) * size;
          const s = std.sin(angle) * size;
          const shades = scramble(looks);
          const shade = 1 + vary * ((d.f32(shades & 0xffff) / 65536) * 0.28 - 0.18);
          const hue = std.select(d.vec3f(0.85, 0.95, 1), d.vec3f(1.1, 1.05, 0.7), (shades & 0x10000) !== 0);
          matrixAt.$[at] = d.mat4x4f(c, 0, -s, 0, 0, size, 0, 0, s, 0, c, 0, x, heightAt(x, z), z, 1);
          colorAt.$[at] = d.vec4f(std.mix(d.vec3f(shade), hue, vary * 0.35 * (d.f32(shades >>> 17) / 32768)), 1);
        })
        .compute(count);
      if (!color) return [plant];
      // in TSL, as `color` is: each instance coloured where the planting placed it
      const paint = Fn(() => {
        const at = uint(start).add(slot.node.mul(count)).add(instanceIndex);
        // a mat4 is four vec4 columns, its fourth the translation
        const place = storage(matrices, "vec4", matrices.count * 4)
          .toReadOnly()
          .element(at.mul(4).add(3));
        storage(colors, "vec4", colors.count)
          .element(at)
          .assign(vec4(color(place.xz), 1));
      })().compute(count);
      return [plant, paint];
    };

    const counts = shareOut(
      plantings.map(({ share }) => share),
      capacity,
      stand.name,
    );
    const order = shuffled(capacity, stand.name);
    const firsts = counts.map((_, p) => counts.slice(0, p).reduce((a, b) => a + b, 0));
    const outputs = await Promise.all(
      plantings.map(async (planting, p) => {
        const count = counts[p] ?? 0;
        if (count === 0) return [];
        const first = firsts[p] ?? 0;
        const spots = Uint32Array.from(order.slice(first, first + count));
        const [range, lod] = await Promise.all([scatter.take(planting.url, room * count, true), scatter.lod(planting.url)]);
        return [{ planting, spots, range, reach: reach(lod.levels) }];
      }),
    );
    const planted = outputs.flat();
    /** The passes, made as the first tile is planted, once the Scatter has sealed. */
    let passes: ReturnType<typeof pass> | undefined;

    /** The box of tile (i, j)'s origins: over it, between the ground's heights under it. */
    const originBox = (i: number, j: number): THREE.Box3 => {
      let lowest = Infinity;
      let highest = -Infinity;
      for (let b = 0; b <= tile + CELL; b += CELL)
        for (let a = 0; a <= tile + CELL; a += CELL) {
          const height = plan.terrain.height(i * tile + a, j * tile + b);
          lowest = Math.min(lowest, height);
          highest = Math.max(highest, height);
        }
      return new THREE.Box3(new THREE.Vector3(i * tile, lowest - SLACK, j * tile), new THREE.Vector3((i + 1) * tile, highest + SLACK, (j + 1) * tile));
    };

    const tiles = new NearTiles({
      near: (eye) => tilesAround(eye, Math.max(0, eye.y - plan.terrain.height(eye.x, eye.z)), { radius, tile, holds: (key) => holding.has(key) }),
      fill: (key, at) => {
        const [i, j] = tileAt(key);
        tileId.node.value = key;
        turn.node.value = Math.imul(key, 0x9e3779b1) >>> 0;
        x0.node.value = i * tile;
        z0.node.value = j * tile;
        slot.node.value = at;
        passes ??= planted.flatMap(({ planting, spots, range }) => pass(planting, spots, range));
        void renderer.compute(passes);
        const origins = originBox(i, j);
        return planted.map(({ planting: { scale }, spots, range, reach }) => {
          const [minScale, maxScale] = scale;
          const clusters = range.node.clusters;
          if (!clusters) throw new Error(`${stand.name}: its Scatter has not sealed`);
          const boundingBox = origins.clone().expandByScalar(reach * maxScale);
          return { clusters, cluster: { start: range.start + at * spots.length, count: spots.length, boundingBox, minScale, maxScale } };
        });
      },
      perFrame: PER_FRAME,
      room,
    });
    tiles.name = stand.name;
    return tiles;
  };
}

/** `total` shared out by `shares`, which add up to 1, in whole numbers: each its share rounded down, the largest remainders up. */
function shareOut(shares: readonly number[], total: number, name: string): number[] {
  const sum = shares.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`${name}: its plantings' shares add up to ${sum}, not 1`);
  const exact = shares.map((share) => share * total);
  const counts = exact.map(Math.floor);
  const left = total - counts.reduce((a, b) => a + b, 0);
  const byRemainder = exact.map((value, i) => ({ i, remainder: value - Math.floor(value) })).sort((a, b) => b.remainder - a.remainder);
  for (const { i } of byRemainder.slice(0, left)) counts[i] = (counts[i] ?? 0) + 1;
  return counts;
}

/** The numbers below `count` in an order seeded by `seed`. */
function shuffled(count: number, seed: string): number[] {
  const random = seedrandom(seed);
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swapped = order[j] ?? 0;
    order[j] = order[i] ?? 0;
    order[i] = swapped;
  }
  return order;
}

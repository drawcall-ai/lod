// The compute pass plants stream from, and how a crowd reads its records. A record is one word: the copy's position
// bits and its hash, 0 where nothing grows. What a copy looks like comes from the hash alone, so a tile streamed in
// again shows the same copies, and crowds sharing a stream each keep their own share of its records.
import { GpuInstance, type GpuRecords } from "@drawcall/lod";
import * as t3 from "@typegpu/three";
import type { WebGPURenderer } from "three/webgpu";
import tgpu, { d, std } from "typegpu";
import type { Plan } from "./plan.ts";
import { SLOTS, Stream, tileKey, type Crowd } from "./stream.ts";
import { CELL, EXTENT } from "./terrain.ts";

/** Metres a tile's box reaches beyond the ground's heights under it. */
const SLACK = 1;
/** A crowd's pool over what its share holds on average: a tile's copies fall unevenly among crowds. */
const UNEVEN = 1.5;

/** A u32 mixed so that each bit depends on all of them. */
function scramble(x: number): number {
  "use gpu";
  let h = d.u32(x);
  h = (h ^ (h >>> 16)) * d.u32(0x85ebca6b);
  h = (h ^ (h >>> 13)) * d.u32(0xc2b2ae35);
  return h ^ (h >>> 16);
}

/** Plants streamed around the camera on a jittered grid. */
export interface Stand {
  name: string;
  /** Edge of a tile (m). */
  tile: number;
  /** Plants per square metre, before `grows`. */
  density: number;
  /** How far from the camera they are held (m). */
  radius: number;
  grows: (x: number, z: number) => boolean;
}

/** A crowd's records from a stand: `share` is about how much of the stand it keeps. */
export type RecordsOf = (instance: GpuRecords["instance"], scales: GpuRecords["scales"], share: number) => GpuRecords;

/** Makes the streams of the plants on `plan`'s ground, which share its heights on the GPU. */
export function stands(plan: Plan, renderer: WebGPURenderer) {
  const { heights } = plan.terrain;
  const levels = t3.instancedArray(heights, d.f32);
  const cells = Math.sqrt(heights.length) - 1;

  const levelAt = (i: number, j: number): number => {
    "use gpu";
    return d.f32(levels.$[d.u32(j) * d.u32(cells + 1) + d.u32(i)]);
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
      const h00 = levelAt(i, j);
      return h00 + (levelAt(i + 1, j) - h00) * fx + (levelAt(i, j + 1) - h00) * fz;
    }
    const h11 = levelAt(i + 1, j + 1);
    return h11 + (levelAt(i, j + 1) - h11) * (1 - fx) + (levelAt(i + 1, j) - h11) * (1 - fz);
  };

  return (stand: Stand, crowdsOf: (records: RecordsOf) => Crowd[]): Stream => {
    const { tile, density, radius, grows } = stand;
    const side = plan.land.size;
    const raster = (2 * EXTENT) / side;
    const growth = new Uint32Array(Math.ceil((side * side) / 32));
    const holding = new Set<number>();
    for (let j = 0; j < side; j++)
      for (let i = 0; i < side; i++) {
        const x = -EXTENT + (i + 0.5) * raster;
        const z = -EXTENT + (j + 0.5) * raster;
        if (!grows(x, z)) continue;
        const k = j * side + i;
        growth[k >>> 5] = (growth[k >>> 5] ?? 0) | (1 << (k & 31));
        holding.add(tileKey(Math.floor(x / tile), Math.floor(z / tile)));
      }

    const perSide = Math.max(1, Math.round(tile * Math.sqrt(density)));
    const capacity = perSide * perSide;
    const spacing = tile / perSide;
    const records = t3.instancedArray(SLOTS * capacity, d.vec4u);
    const counters = t3.instancedArray(SLOTS, d.u32);
    const growing = t3.instancedArray(growth, d.u32);
    const key = t3.uniform(0, d.u32);
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

    const write = t3
      .toTSL(() => {
        "use gpu";
        const k = t3.instanceIndex.$;
        const hash = scramble(key.$ + k * d.u32(0x9e3779b9));
        const jitter = scramble(hash);
        const x = x0.$ + (d.f32(k % perSide) + d.f32(jitter & 0xffff) / 65536) * spacing;
        const z = z0.$ + (d.f32(std.intdiv(k, perSide)) + d.f32(jitter >>> 16) / 65536) * spacing;
        records.$[slot.$ * capacity + k] = d.vec4u(std.bitcastF32toU32(d.vec3f(x, heightAt(x, z), z)), std.select(0, hash | 1, growsAt(x, z)));
        if (k === 0) counters.$[slot.$] = capacity;
      })
      .compute(capacity);

    const area = Math.PI * (radius + tile) ** 2;
    const tiles = Math.min(Math.ceil(area / (tile * tile)), holding.size);
    const crowds = crowdsOf((instance, scales, share) => ({
      instance,
      records: records.node.value,
      counters: counters.node.value,
      capacity,
      scales,
      chunks: tiles,
      instances: Math.ceil(UNEVEN * tiles * capacity * share),
    }));
    const stream = new Stream(crowds, {
      radius,
      tile,
      capacity,
      holds: (tileId) => holding.has(tileId),
      heightsOver: (x, z) => {
        let low = Infinity;
        let high = -Infinity;
        for (let b = 0; b <= tile + CELL; b += CELL)
          for (let a = 0; a <= tile + CELL; a += CELL) {
            const height = plan.terrain.height(x + a, z + b);
            low = Math.min(low, height);
            high = Math.max(high, height);
          }
        return [low - SLACK, high + SLACK];
      },
      emit: (i, j, at) => {
        key.node.value = tileKey(i, j);
        x0.node.value = i * tile;
        z0.node.value = j * tile;
        slot.node.value = at;
        void renderer.compute(write);
      },
    });
    stream.name = stand.name;
    return stream;
  };
}

/**
 * A copy of the records whose hash picks between `from` and `to` (0..1), scaled between `scale` and, when `tinted`, a
 * little lighter or darker, yellower or bluer; other records make no copy.
 */
export function plantInstance(from: number, to: number, [low, high]: readonly [number, number], tinted = false) {
  const vary = tinted ? 1 : 0;
  return tgpu.fn([d.vec4u], GpuInstance)((spot) => {
    "use gpu";
    const hash = spot.w;
    const looks = scramble(hash);
    const pick = d.f32(looks & 0xffff) / 65536;
    const scale = low + ((high - low) * d.f32(looks >>> 16)) / 65536;
    const angle = (d.f32(hash >>> 16) / 65536) * 2 * Math.PI;
    const p = std.bitcastU32toF32(spot.xyz);
    const c = std.cos(angle) * scale;
    const s = std.sin(angle) * scale;
    const shades = scramble(looks);
    const shade = 1 + vary * (d.f32(shades & 0xffff) / 65536 * 0.28 - 0.18);
    const hue = std.select(d.vec3f(0.85, 0.95, 1), d.vec3f(1.1, 1.05, 0.7), (shades & 0x10000) !== 0);
    return GpuInstance({
      matrix: d.mat4x4f(c, 0, -s, 0, 0, scale, 0, 0, s, 0, c, 0, p.x, p.y, p.z, 1),
      color: std.mix(d.vec3f(shade), hue, vary * 0.35 * (d.f32(shades >>> 17) / 32768)),
      keep: std.select(d.f32(hash & 0xffff) / 65536, 1, hash === 0 || pick < from || pick >= to),
    });
  });
}

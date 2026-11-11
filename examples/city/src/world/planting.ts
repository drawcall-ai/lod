// The compute pass that plants forests and ground cover in the tiles near the camera. A stand's tiles hold spots on a
// jittered grid; each spot's hash picks the one InstancedLod that draws it, how large it grows, how it turns and its
// tint, so a tile planted again shows the same plants. Every InstancedLod has an output of its own: per slot of the ring, a whole tile's spots, each the finished
// instance where it plants one and a matrix of scale 0 (no instance) elsewhere; the InstancedLod packs only the first.
import { InstancedLod, type LodPool, type LodLevel } from "@drawcall/lod";
import * as t3 from "@typegpu/three";
import { storage } from "three/tsl";
import * as THREE from "three/webgpu";
import { d, std } from "typegpu";
import type { Plan } from "./plan.ts";
import { NearTiles, tileAt, tileKey, tilesAround, type TileChunk } from "./near-tiles.ts";
import { CELL, EXTENT } from "./terrain.ts";

/**
 * Tiles planted per frame, each into one slot of the ring every InstancedLod's output holds. An InstancedLod reads a
 * planted chunk in the first render that updates it, so a slot written in one frame is written again only in the next:
 * the city updates the tiles before each frame's render, and every render draws the InstancedLods.
 */
const SLOTS = 4;
/** Metres a tile's box of origins reaches beyond the ground's heights under it. */
const SLACK = 1;
/** An InstancedLod's room over what its share of the tiles holds on average: a tile's spots fall unevenly among them. */
const UNEVEN = 1.5;

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
  /** Plants per square metre, before `grows`. */
  density: number;
  /** How far from the camera they are held (m). */
  radius: number;
  grows: (x: number, z: number) => boolean;
}

/**
 * One InstancedLod of a stand: it draws the spots whose hash picks within [from, to) (0..1), scaled within `scale`
 * and, when `tinted`, a little lighter or darker, yellower or bluer.
 */
export interface Planting {
  name: string;
  levels: readonly LodLevel[];
  from: number;
  to: number;
  scale: readonly [number, number];
  tinted?: boolean;
}

/** Plants stands on `plan`'s ground, whose heights its passes, run on `renderer`, share on the GPU. */
export function planter(plan: Plan, pool: LodPool, renderer: THREE.Renderer) {
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

  /** The tiles of `stand` near the camera, its InstancedLods made from `plantings`, in their order. */
  return (stand: Stand, plantings: readonly Planting[]): NearTiles => {
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
    const growing = t3.instancedArray(growth, d.u32);
    const tileId = t3.uniform(0, d.u32);
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

    /** The output of `planting`'s InstancedLod, and the pass that plants a tile into a slot of it. */
    const output = ({ from, to, scale: [low, high], tinted = false }: Planting) => {
      const matrices = new THREE.StorageInstancedBufferAttribute(SLOTS * capacity, 16);
      const colors = new THREE.StorageInstancedBufferAttribute(SLOTS * capacity, 3);
      const matrixAt = t3.fromTSL(storage(matrices, "mat4", matrices.count), d.arrayOf(d.mat4x4f));
      const colorAt = t3.fromTSL(storage(colors, "vec3", colors.count), d.arrayOf(d.vec3f));
      const vary = tinted ? 1 : 0;
      const pass = t3
        .toTSL(() => {
          "use gpu";
          const k = t3.instanceIndex.$;
          const at = slot.$ * capacity + k;
          // no instance, unless this spot plants one
          matrixAt.$[at] = d.mat4x4f();
          const hash = scramble(tileId.$ + k * d.u32(0x9e3779b9));
          const seed = hash | 1;
          const looks = scramble(seed);
          const pick = d.f32(looks & 0xffff) / 65536;
          if (pick < from || pick >= to) return;
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
          colorAt.$[at] = std.mix(d.vec3f(shade), hue, vary * 0.35 * (d.f32(shades >>> 17) / 32768));
        })
        .compute(capacity);
      return { matrices, colors, pass };
    };

    const area = Math.PI * (radius + tile) ** 2;
    const tiles = Math.min(Math.ceil(area / (tile * tile)), holding.size);
    const outputs = plantings.map((planting) => {
      const lod = new InstancedLod(planting.levels, pool, {
        maxInstanceCount: Math.ceil(UNEVEN * tiles * capacity * (planting.to - planting.from)),
      });
      lod.name = planting.name;
      return { lod, planting, ...output(planting) };
    });
    const passes = outputs.map(({ pass }) => pass);

    /** The box of tile (i, j)'s origins: over it, between the ground's heights under it. */
    const originBox = (i: number, j: number): THREE.Box3 => {
      let low = Infinity;
      let high = -Infinity;
      for (let b = 0; b <= tile + CELL; b += CELL)
        for (let a = 0; a <= tile + CELL; a += CELL) {
          const height = plan.terrain.height(i * tile + a, j * tile + b);
          low = Math.min(low, height);
          high = Math.max(high, height);
        }
      return new THREE.Box3(new THREE.Vector3(i * tile, low - SLACK, j * tile), new THREE.Vector3((i + 1) * tile, high + SLACK, (j + 1) * tile));
    };

    const planted = new NearTiles(
      outputs.map(({ lod }) => lod),
      {
        near: (eye) => tilesAround(eye, Math.max(0, eye.y - plan.terrain.height(eye.x, eye.z)), { radius, tile, holds: (key) => holding.has(key) }),
        chunks: (key, at): TileChunk[] => {
          const [i, j] = tileAt(key);
          tileId.node.value = key;
          x0.node.value = i * tile;
          z0.node.value = j * tile;
          slot.node.value = at;
          void renderer.compute(passes);
          const box = originBox(i, j);
          return outputs.map(({ lod, planting, matrices, colors }) => ({
            lod,
            parameters: {
              instanceMatrix: matrices,
              instanceColor: colors,
              start: at * capacity,
              count: capacity,
              originBox: box,
              minScale: planting.scale[0],
              maxScale: planting.scale[1],
            },
          }));
        },
        perFrame: SLOTS,
      },
    );
    planted.name = stand.name;
    return planted;
  };
}

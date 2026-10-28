import { Vector2 } from "three/webgpu";
import { Land } from "../land.ts";
import { Terrain } from "../terrain.ts";
import { houseVariants, type Plan, type Spot, type Rect, type Road } from "../plan.ts";

type Files = Record<"layout" | "heights" | "cells" | "parcels", Uint8Array>;

export function encode(world: Plan): Files {
  const { terrain, land, variants: _, models, garden, signs, ...layout } = world;
  return {
    layout: new TextEncoder().encode(JSON.stringify({ ...layout, models: [...models], garden: [...garden], signs: [...signs] })),
    heights: new Uint8Array(terrain.heights.buffer, terrain.heights.byteOffset, terrain.heights.byteLength),
    cells: land.cells,
    parcels: land.parcels,
  };
}

export function decode(files: Files): Plan {
  const value: unknown = JSON.parse(new TextDecoder().decode(files.layout));
  const data = record(value);
  const heights = files.heights;
  if (heights.byteLength % 4) throw new Error("Invalid terrain bytes");
  const variants = houseVariants();
  return {
    terrain: new Terrain(new Float32Array(heights.slice().buffer)),
    land: new Land(files.cells, files.parcels),
    variants,
    roads: list(data.roads, road),
    plaza: rect(data.plaza),
    fields: list(data.fields, rect),
    forests: list(data.forests, (value) => {
      const r = record(value);
      return { x: number(r.x), z: number(r.z), radius: number(r.radius), phase: number(r.phase) };
    }),
    houses: list(data.houses, (value) => {
      const r = record(value);
      const variant = number(r.variant);
      if (!Number.isInteger(variant) || variant < 0 || variant >= variants.length) throw new Error("Invalid house variant");
      return { variant, spot: spot(r.spot) };
    }),
    fences: list(data.fences, spot),
    garden: spots(data.garden),
    hedges: list(data.hedges, spot),
    church: spot(data.church),
    signs: spots(data.signs),
    models: spots(data.models),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid plan object");
  return Object.fromEntries(Object.entries(value));
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid plan number");
  return value;
}
function list<T>(value: unknown, read: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Invalid plan list");
  return value.map(read);
}
function spot(value: unknown): Spot {
  const r = record(value);
  return { x: number(r.x), y: number(r.y), z: number(r.z), angle: number(r.angle), scale: number(r.scale) };
}
function rect(value: unknown): Rect {
  const r = record(value);
  return { x: number(r.x), z: number(r.z), halfX: number(r.halfX), halfZ: number(r.halfZ), angle: number(r.angle) };
}
function road(value: unknown): Road {
  const r = record(value);
  const kind = r.kind;
  if (kind !== "main" && kind !== "street" && kind !== "track" && kind !== "path" && kind !== "drive" && kind !== "bed") throw new Error("Invalid road kind");
  if (typeof r.pavement !== "boolean") throw new Error("Invalid pavement");
  return {
    kind,
    pavement: r.pavement,
    width: number(r.width),
    points: list(r.points, (value) => {
      const p = record(value);
      return new Vector2(number(p.x), number(p.y));
    }),
  };
}
function spots(value: unknown): Map<string, Spot[]> {
  return new Map(
    list(value, (entry): [string, Spot[]] => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") throw new Error("Invalid spot collection");
      return [entry[0], list(entry[1], spot)];
    }),
  );
}

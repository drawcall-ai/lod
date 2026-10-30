import { cachedNumber, cachedRecord } from "../../cache.ts";
import { MeshBasicMaterial, Vector2 } from "three/webgpu";
import { encode as encodeGeometry, decode as decodeGeometry } from "./geometry.ts";
import { roadShapes, restoreRoadShapes } from "../roads.ts";
import { Land } from "../land.ts";
import { Terrain } from "../terrain.ts";
import { HOUSE_VARIANTS } from "../../../public/content/house/params.ts";
import { type Plan, type Spot, type Rect, type Road } from "../plan.ts";

type Files = Record<string, Uint8Array>;

export async function encode(world: Plan): Promise<Files> {
  const { terrain, land, models, garden, signs, ...layout } = world;
  const material = new MeshBasicMaterial();
  const files: Files = {};
  const geometries = { terrain: terrain.mesh(material).geometry, ...roadShapes(world) };
  for (const [name, geometry] of Object.entries(geometries)) encodeGeometry(geometry, name, files);
  material.dispose();
  return transform(
    {
      ...files,
      layout: new TextEncoder().encode(JSON.stringify({ ...layout, models: [...models], garden: [...garden], signs: [...signs] })),
      heights: new Uint8Array(terrain.heights.buffer, terrain.heights.byteOffset, terrain.heights.byteLength),
      cells: land.cells,
      parcels: land.parcels,
    },
    () => new CompressionStream("gzip"),
  );
}

export async function decode(files: Files): Promise<Plan> {
  files = await transform(files, () => new DecompressionStream("gzip"));
  const value: unknown = JSON.parse(new TextDecoder().decode(required(files, "layout")));
  const data = cachedRecord(value);
  const heights = required(files, "heights");
  if (heights.byteLength % 4) throw new Error("Invalid terrain bytes");
  const geometry = (name: string) => decodeGeometry(name, files);
  const world: Plan = {
    terrain: new Terrain(new Float32Array(heights.slice().buffer), geometry("terrain")),
    land: new Land(required(files, "cells"), required(files, "parcels")),
    roads: list(data.roads, road),
    plaza: rect(data.plaza),
    fields: list(data.fields, rect),
    forests: list(data.forests, (value) => {
      const r = cachedRecord(value);
      return { x: cachedNumber(r.x), z: cachedNumber(r.z), radius: cachedNumber(r.radius), phase: cachedNumber(r.phase) };
    }),
    houses: list(data.houses, (value) => {
      const r = cachedRecord(value);
      const variant = cachedNumber(r.variant);
      if (!Number.isInteger(variant) || variant < 0 || variant >= HOUSE_VARIANTS) throw new Error("Invalid house variant");
      return { variant, spot: spot(r.spot) };
    }),
    fences: list(data.fences, spot),
    garden: spots(data.garden),
    hedges: list(data.hedges, spot),
    church: spot(data.church),
    signs: spots(data.signs),
    models: spots(data.models),
  };
  restoreRoadShapes(world, {
    asphalt: geometry("asphalt"),
    tracks: geometry("tracks"),
    pavements: geometry("pavements"),
    beds: geometry("beds"),
    plaza: geometry("plaza"),
  });
  return world;
}

async function transform(files: Files, stream: () => CompressionStream | DecompressionStream): Promise<Files> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([name, bytes]) => [
        name,
        new Uint8Array(await new Response(new Blob([bytes.slice()]).stream().pipeThrough(stream())).arrayBuffer()),
      ]),
    ),
  );
}

function required(files: Files, name: string): Uint8Array {
  const bytes = files[name];
  if (!bytes) throw new Error(`Missing cached plan ${name}`);
  return bytes;
}

function list<T>(value: unknown, read: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Invalid plan list");
  return value.map(read);
}
function spot(value: unknown): Spot {
  const r = cachedRecord(value);
  return { x: cachedNumber(r.x), y: cachedNumber(r.y), z: cachedNumber(r.z), angle: cachedNumber(r.angle), scale: cachedNumber(r.scale) };
}
function rect(value: unknown): Rect {
  const r = cachedRecord(value);
  return { x: cachedNumber(r.x), z: cachedNumber(r.z), halfX: cachedNumber(r.halfX), halfZ: cachedNumber(r.halfZ), angle: cachedNumber(r.angle) };
}
function road(value: unknown): Road {
  const r = cachedRecord(value);
  const kind = r.kind;
  if (kind !== "main" && kind !== "street" && kind !== "track" && kind !== "path" && kind !== "drive" && kind !== "bed") throw new Error("Invalid road kind");
  if (typeof r.pavement !== "boolean") throw new Error("Invalid pavement");
  return {
    kind,
    pavement: r.pavement,
    width: cachedNumber(r.width),
    points: list(r.points, (value) => {
      const p = cachedRecord(value);
      return new Vector2(cachedNumber(p.x), cachedNumber(p.y));
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

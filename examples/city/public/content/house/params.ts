import { Random } from "../random.ts";

/**
 * Everything both house levels are built from. The footprint is centred on the origin,
 * the ridge runs along x, the front (door) facade faces +z, the ground is y = 0.
 */
export interface HouseParams {
  width: number;
  depth: number;
  floors: number;
  floorHeight: number;
  /** Height of the concrete base; the ground floor sits on top of it. */
  plinth: number;
  wall: { kind: "stucco" | "brick" | "whitewash"; color: string };
  roof: { tiles: "clay" | "slate"; color: string; pitch: number; overhang: number };
  /** Paint of window frames, fascia and bargeboards. */
  trim: string;
  door: string;
  shutters: string | null;
  /** Stack on the back slope: x position, height above the ridge, number of pots. */
  chimney: { x: number; height: number; pots: number } | null;
  /** Window columns on the long facades and the gable sides. */
  columns: number;
  sideColumns: number;
  seed: number;
}

export const HOUSE_VARIANTS = 10;

export const wallThickness = 0.3;
/** Wall height above the top floor's ceiling before the roof starts (knee wall). */
const kneeWall = 0.35;

/** House `variant` is 0-based, below `HOUSE_VARIANTS`. */
export function houseParams(variant: number): HouseParams {
  const seed = variant + 1;
  const r = new Random(seed);
  const floors = r.pick([1, 2, 2, 2, 3]);
  const width = r.range(8, 12.5);
  const depth = r.range(7, 9.5);
  const kind = r.pick(["stucco", "stucco", "brick", "whitewash"] as const);
  const tiles = r.pick(["clay", "clay", "slate"] as const);
  return {
    width,
    depth,
    floors,
    floorHeight: r.range(2.75, 3.0),
    plinth: r.range(0.35, 0.55),
    wall: { kind, color: kind === "stucco" ? r.pick(["#f1ece2", "#efe1c4", "#e6d3b3", "#dfe3e0", "#f3dfcf", "#e9e6dc"]) : "#ffffff" },
    roof: {
      tiles,
      color: tiles === "clay" ? r.pick(["#9a4a30", "#8c4431", "#a0593b", "#7a3c2a"]) : r.pick(["#3c4045", "#45484c", "#353a40"]),
      pitch: r.range(35, 48),
      overhang: r.range(0.45, 0.65),
    },
    trim: r.pick(["#f4f2ec", "#f4f2ec", "#2f3a35", "#e8e2d4", "#3a3f44"]),
    door: r.pick(["#5a2a22", "#2e4a3c", "#24334a", "#6b4a2b", "#3a3a3a"]),
    shutters: kind === "stucco" && r.chance(0.5) ? r.pick(["#4f6b56", "#5b7387", "#7a8a8f", "#8c5a3c"]) : null,
    chimney: r.chance(0.75) ? { x: r.range(-0.3, 0.3) * width, height: r.range(0.7, 1.0), pots: r.int(1, 2) } : null,
    columns: Math.max(2, Math.floor(width / 2.6)),
    sideColumns: Math.max(1, Math.floor(depth / 3.2)),
    seed,
  };
}

/** The chimney stack's centre sits this far behind the ridge, on the back slope. */
export const chimneyZ = -0.75;
export const chimneySize = { w: 0.6, d: 0.72 };

/** Derived heights shared by the detailed and the low house. */
export function heights(p: HouseParams) {
  const eave = p.plinth + p.floors * p.floorHeight + kneeWall;
  const run = p.depth / 2;
  const slope = Math.tan((p.roof.pitch * Math.PI) / 180);
  return { eave, ridge: eave + run * slope, slope };
}

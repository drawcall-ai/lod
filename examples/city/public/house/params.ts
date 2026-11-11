import seedrandom from "seedrandom";

/** One of `items`, by `r`. */
export function pick<T>(r: seedrandom.PRNG, items: readonly T[]): T {
  const item = items[Math.floor(r() * items.length)];
  if (item === undefined) throw new Error("pick from an empty list");
  return item;
}

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

/** The house variant a script's URL asks for with `?variant=` (0 if it does not), checked. */
export function variantOf(url: string): number {
  const text = new URL(url).searchParams.get("variant") ?? "0";
  const variant = Number(text);
  if (!(/^\d+$/.test(text) && variant < HOUSE_VARIANTS)) throw new Error(`house: variant must be a whole number below ${HOUSE_VARIANTS}, not ${text}`);
  return variant;
}

export const wallThickness = 0.3;
/** Wall height above the top floor's ceiling before the roof starts (knee wall). */
const kneeWall = 0.35;

/** House `variant` is 0-based, below `HOUSE_VARIANTS`. */
export function houseParams(variant: number): HouseParams {
  const seed = variant + 1;
  const r = seedrandom(String(seed));
  const floors = pick(r, [1, 2, 2, 2, 3]);
  const width = 8 + 4.5 * r();
  const depth = 7 + 2.5 * r();
  const kind = pick(r, ["stucco", "stucco", "brick", "whitewash"] as const);
  const tiles = pick(r, ["clay", "clay", "slate"] as const);
  return {
    width,
    depth,
    floors,
    floorHeight: 2.75 + 0.25 * r(),
    plinth: 0.35 + 0.2 * r(),
    wall: { kind, color: kind === "stucco" ? pick(r, ["#f1ece2", "#efe1c4", "#e6d3b3", "#dfe3e0", "#f3dfcf", "#e9e6dc"]) : "#ffffff" },
    roof: {
      tiles,
      color: tiles === "clay" ? pick(r, ["#9a4a30", "#8c4431", "#a0593b", "#7a3c2a"]) : pick(r, ["#3c4045", "#45484c", "#353a40"]),
      pitch: 35 + 13 * r(),
      overhang: 0.45 + 0.2 * r(),
    },
    trim: pick(r, ["#f4f2ec", "#f4f2ec", "#2f3a35", "#e8e2d4", "#3a3f44"]),
    door: pick(r, ["#5a2a22", "#2e4a3c", "#24334a", "#6b4a2b", "#3a3a3a"]),
    shutters: kind === "stucco" && r() < 0.5 ? pick(r, ["#4f6b56", "#5b7387", "#7a8a8f", "#8c5a3c"]) : null,
    chimney: r() < 0.75 ? { x: (-0.3 + 0.6 * r()) * width, height: 0.7 + 0.3 * r(), pots: 1 + Math.floor(2 * r()) } : null,
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

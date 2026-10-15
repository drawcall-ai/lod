// The bench behind the package defaults (see src/bench.ts): every level type and setting
// against the source across on-screen heights, in headless Chromium on the real GPU.
// Decides, per subject and level, the largest height at which the level stays within
// BUDGET, and compares it with the maxPixels the loader predicts for the level. Writes
// results.json and one contact sheet per subject to .artifacts/bench.
//
//   pnpm --filter @drawcall/lod-example-lab bench [subject,subject...] [--quick] [--no-flicker] [--no-cost]
//
// The full run takes about 15 minutes on an M2 Pro; --quick about 2.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { LevelRequest } from "@drawcall/lod";
import type { View } from "../src/bench.ts";
import { at, must } from "../src/must.ts";
import { artifacts, open, savePng } from "./lab.ts";

const args = process.argv.slice(2);
const quick = args.includes("--quick");
const named = args.find((a) => !a.startsWith("--"))?.split(",");

/**
 * What a level may add at a height over the floor (the source against itself shifted by
 * an eighth of a pixel, which is what a camera creeping forward changes anyway): mean and
 * 99th percentile colour difference where both cover, in 8-bit sRGB steps, and
 * silhouette mismatch per edge pixel (0.5: the outline is off by half a pixel on
 * average). A mean of 3 is about the floor of a textured subject; it lets through the
 * constant shading offset of an impostor on an opaque prop (2 to 3 at every height),
 * which says nothing about where to switch.
 */
const BUDGET = { colourMean: 3, colourP99: 40, silhouette: 0.5 };
/** Stop measuring a level that passed once and then failed this loosened budget twice in a row. */
const STOP = { colourMean: 6, colourP99: Infinity, silhouette: 1.5 };

const SUBJECTS =
  named ?? (quick ? ["tree", "rock", "house"] : ["tree", "pine", "dead", "twisted", "bush", "fern", "rock", "fence", "sign", "house", "oak", "boulder"]);
const COST_SUBJECTS = ["tree", "rock", "house"];
const HEIGHTS = quick ? [16, 32, 64, 128, 256, 512] : [16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024];
const FLICKER_HEIGHTS = quick ? [64] : [32, 96, 256];
const COST_HEIGHTS = quick ? [32, 256] : [16, 32, 64, 128, 256, 512, 1024];
const VIEWS: View[] = quick
  ? [20, 110, 200, 290].map((azimuth) => ({ azimuth, elevation: 20 }))
  : [
      ...[10, 45].flatMap((elevation) => [0, 45, 90, 135, 180, 225, 270, 315].map((a) => ({ azimuth: a + 20, elevation }))),
      ...[0, 90, 180, 270].map((azimuth) => ({ azimuth, elevation: 75 })),
    ];
const FLICKER_VIEWS: View[] = [
  { azimuth: 30, elevation: 10 },
  { azimuth: 200, elevation: 40 },
];

const REQUESTS: Array<{ key: string; request: LevelRequest }> = [
  ...[0.5, 0.25, 0.1, 0.05].map((ratio) => ({ key: `simplified ${ratio}`, request: { type: "simplified", ratio } as const })),
  ...[0.25, 0.05].map((ratio) => ({ key: `baked ${ratio}`, request: { type: "baked", ratio } as const })),
  { key: "baked shell", request: { type: "baked", low: "shell.glb" } },
  ...(["hemi", "full"] as const).flatMap((layout) =>
    [64, 128, 256].map((resolution) => ({ key: `impostor ${layout} ${resolution}`, request: { type: "impostor", layout, resolution } as const })),
  ),
];

interface Stats {
  colourSum: number;
  both: number;
  biasSum: number;
  histogram: number[];
  xor: number;
  perimeter: number;
}
interface Row {
  height: number;
  colourMean: number;
  colourP99: number;
  silhouette: number;
  /** mean signed luminance difference, level - source, 8-bit steps */
  bias: number;
}
interface Level {
  key: string;
  triangles: number;
  predicted: number;
  maxPixels: number;
  ratio: number;
  rows: Row[];
  flicker?: Record<number, number>;
  cost?: Record<number, number>;
  costSpread?: number;
}

const round = (x: number, digits = 2) => Math.round(x * 10 ** digits) / 10 ** digits;

function summarize(height: number, s: Stats): Row {
  let seen = 0;
  let bin = 0;
  while (bin < s.histogram.length - 1 && seen + at(s.histogram, bin) < 0.99 * s.both) seen += at(s.histogram, bin++);
  const per = (x: number) => (s.both ? round(x / s.both) : 0);
  return { height, colourMean: per(s.colourSum), colourP99: bin / 4, silhouette: round(s.perimeter ? s.xor / s.perimeter : 0), bias: per(s.biasSum) };
}
const excess = (row: Row, floor: Row) => ({
  colourMean: row.colourMean - floor.colourMean,
  colourP99: row.colourP99 - floor.colourP99,
  silhouette: row.silhouette - floor.silhouette,
});
const floorAt = (floor: Row[], height: number) =>
  must(
    floor.find((f) => f.height === height),
    `floor at ${height} px`,
  );
function within(row: Row, floor: Row, budget: typeof BUDGET): boolean {
  const e = excess(row, floor);
  return e.colourMean <= budget.colourMean && e.colourP99 <= budget.colourP99 && e.silhouette <= budget.silhouette;
}

const out = await artifacts("bench");
const { page, close } = await open("bench.html", "bench");
const began = performance.now();
const elapsed = () => `${Math.round((performance.now() - began) / 1000)}s`;
try {
  const { renderer, sheetHeights } = await page.evaluate(() => window.bench.info());
  console.log(`${renderer}; ${quick ? "quick" : "full"} run, ${VIEWS.length} views, ${HEIGHTS.length} heights`);

  const subjects: Record<string, { diameter: number; triangles: number; floor: Row[]; levels: Level[]; sourceCost?: Record<number, number> }> = {};
  for (const name of SUBJECTS) {
    const prepared = await page.evaluate(([n, r]) => window.bench.prepare(n, r), [name, REQUESTS] as const);
    console.log(`\n${name}: ${prepared.triangles} triangles; built in ${prepared.levels.map((l) => `${l.key} ${l.buildMs}ms`).join(", ")} (${elapsed()})`);
    const keys = prepared.levels.map((l) => l.key);

    const rows: Record<string, Row[]> = Object.fromEntries(keys.map((k) => [k, []]));
    const floor: Row[] = [];
    const passed = new Set<string>();
    const fails: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const height of HEIGHTS) {
      const sheet = sheetHeights.includes(height);
      const active = keys.filter((k) => must(fails[k], k) < 2 || sheet);
      const m = await page.evaluate(([h, v, k, s]) => window.bench.measure(h, v, k, s), [height, VIEWS, active, sheet ? 0 : -1] as const);
      const f = summarize(height, m.floor);
      floor.push(f);
      for (const key of active) {
        const row = summarize(height, must(m.levels[key], key));
        must(rows[key], key).push(row);
        if (within(row, f, BUDGET)) passed.add(key);
        fails[key] = within(row, f, STOP) || !passed.has(key) ? 0 : must(fails[key], key) + 1;
      }
    }
    await savePng(out, name, await page.evaluate(() => window.bench.sheet()));

    const flicker: Record<string, Record<number, number>> = {};
    if (!args.includes("--no-flicker"))
      for (const height of FLICKER_HEIGHTS) {
        const ratios = await page.evaluate(([h, v, k]) => window.bench.flicker(h, v, k), [height, FLICKER_VIEWS, keys] as const);
        for (const [key, ratio] of Object.entries(ratios)) (flicker[key] ??= {})[height] = round(ratio);
      }

    const cost: Record<string, Record<number, number>> = {};
    const spread: Record<string, number> = {};
    if (!args.includes("--no-cost") && COST_SUBJECTS.includes(name))
      for (const height of COST_HEIGHTS) {
        const c = await page.evaluate(([h, k]) => window.bench.cost(h, k), [height, keys] as const);
        for (const [key, micros] of Object.entries(c.micros)) (cost[key] ??= {})[height] = round(micros, 3);
        for (const [key, s] of Object.entries(c.spread)) spread[key] = Math.max(spread[key] ?? 0, round(s));
      }

    const levels: Level[] = prepared.levels.map((level) => {
      const measured = must(rows[level.key], level.key);
      const passing = measured.filter((row) => within(row, floorAt(floor, row.height), BUDGET));
      const maxPixels = passing.at(-1)?.height ?? 0;
      const { key, triangles } = level;
      const predicted = round(level.predicted, 1);
      return {
        key,
        triangles,
        predicted,
        maxPixels,
        ratio: round(maxPixels / predicted),
        rows: measured,
        flicker: flicker[key],
        cost: cost[key],
        costSpread: spread[key],
      };
    });
    subjects[name] = { diameter: prepared.diameter, triangles: prepared.triangles, floor, levels, sourceCost: cost.source };
    print(floor, levels, cost.source, spread.source);
    console.log(`(${elapsed()})`);
  }

  const calibration = calibrate(subjects);
  console.log("\nmeasured / predicted maxPixels by level type, where the level is acceptable at some height:");
  for (const [type, c] of Object.entries(calibration))
    console.log(`  ${type.padEnd(10)} median ${c.median}, quartiles ${c.low}..${c.high} over ${c.count}; never acceptable: ${c.never.join(", ") || "-"}`);
  await writeFile(
    new URL("results.json", out),
    JSON.stringify({ renderer, quick, budget: BUDGET, views: VIEWS, heights: HEIGHTS, calibration, subjects }, null, 1),
  );
  console.log(`\nresults: ${fileURLToPath(out)} (${elapsed()})`);
} finally {
  await close();
}

/** Per level type, how the measured maxPixels relate to the predicted ones. */
function calibrate(subjects: Record<string, { levels: Level[] }>) {
  const types: Record<string, { ratios: number[]; never: string[] }> = {};
  for (const [name, { levels }] of Object.entries(subjects))
    for (const level of levels) {
      const [type = "", ...settings] = level.key.split(" ");
      const entry = (types[type] ??= { ratios: [], never: [] });
      if (level.maxPixels > 0) entry.ratios.push(level.ratio);
      else entry.never.push(`${name} ${settings.join(" ")}`);
    }
  return Object.fromEntries(
    Object.entries(types).map(([type, { ratios, never }]) => {
      const sorted = [...ratios].sort((a, b) => a - b);
      // NaN where no subject found the type acceptable at any height.
      const quantile = (q: number) => sorted[Math.floor(q * (sorted.length - 1))] ?? NaN;
      return [type, { median: quantile(0.5), low: quantile(0.25), high: quantile(0.75), count: ratios.length, never }];
    }),
  );
}

function print(floor: Row[], levels: Level[], sourceCost: Record<number, number> | undefined, sourceSpread: number | undefined) {
  console.log(`floor ${floor.map((f) => `${f.height}:${f.colourMean}/${f.colourP99}/${f.silhouette}`).join(" ")}`);
  console.log(
    `${"level".padEnd(18)} ${"tris".padStart(6)} ${"pred".padStart(6)} ${"meas".padStart(5)} ${"ratio".padStart(5)}  height:colour mean/p99/silhouette excess, luminance bias (x: over budget)`,
  );
  for (const level of levels) {
    const cells = level.rows.map((row) => {
      const f = floorAt(floor, row.height);
      const e = excess(row, f);
      return `${row.height}:${e.colourMean.toFixed(1)}/${e.colourP99.toFixed(0)}/${e.silhouette.toFixed(2)},${row.bias.toFixed(0)}${within(row, f, BUDGET) ? "" : "x"}`;
    });
    console.log(
      `${level.key.padEnd(18)} ${String(level.triangles).padStart(6)} ${String(level.predicted).padStart(6)} ${String(level.maxPixels).padStart(5)} ${String(level.ratio).padStart(5)}  ${cells.join(" ")}`,
    );
    if (level.flicker) console.log(`${"".padEnd(18)} flicker vs source ${JSON.stringify(level.flicker)}`);
    if (level.cost) console.log(`${"".padEnd(18)} µs/instance ${JSON.stringify(level.cost)} (spread ≤ ${level.costSpread})`);
  }
  if (sourceCost) console.log(`${"source".padEnd(18)} µs/instance ${JSON.stringify(sourceCost)} (spread ≤ ${sourceSpread})`);
}

// Technique study, step 3: GPU time of every combination, measured directly (not summed
// from parts: occlusion between techniques makes sums wrong by up to ~40%).
//
// For each object, view angle, contiguous range of distance bands and technique
// combination with each placement of its switches, a field of the object's instance count
// is drawn from inside: each instance by the technique of the band its on-screen size falls
// in, instances outside the range not at all, near techniques first. Resumable: runs
// already in perf.json are skipped.
//
//   npx tsx scripts/study-perf.ts [object,object...]
//
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { ANGLES, BANDS, COMBOS, OBJECTS, bakedTexture, type Tech } from "./study-config.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = new URL("../../../.artifacts/study/", import.meta.url);
const only = process.argv[2]?.split(",");

/** Ranges of neighbouring bands, as [first, last] indices (near to far). */
const RANGES: Array<[number, number]> = [];
for (let a = 0; a < BANDS.length; a++) for (let b = a; b < BANDS.length; b++) RANGES.push([a, b]);

/** Every way to give each technique of `combo` at least one band of the range, in order. */
function placements(combo: Tech[], first: number, last: number): Tech[][] {
  const n = last - first + 1;
  const result: Tech[][] = [];
  const walk = (i: number, t: number, acc: Tech[]) => {
    if (i === n) return void (t === combo.length - 1 && result.push(acc));
    walk(i + 1, t, [...acc, combo[t]!]);
    if (t + 1 < combo.length && i > 0) walk(i + 1, t + 1, [...acc, combo[t + 1]!]);
  };
  if (combo.length <= n) walk(1, 0, [combo[0]!]);
  return result;
}

/** Field levels for one placement: switch halfway (geometric) between band sizes. */
function levels(active: Tech[], first: number, last: number) {
  const edge = (i: number) => Math.sqrt(BANDS[i]!.px * BANDS[i + 1]!.px); // between band i and i+1
  const result: Array<Record<string, unknown>> = [];
  if (first > 0) result.push({ kind: "none", minPx: edge(first - 1) });
  active.forEach((tech, k) => {
    const band = BANDS[first + k]!;
    const minPx = first + k === BANDS.length - 1 ? 0 : edge(first + k);
    const kind = tech === "real" ? "real" : tech === "lod" ? "lod-simple" : tech === "baked" ? "lod-baked" : "octa";
    const level: Record<string, unknown> = { kind, minPx };
    if (tech === "lod" || tech === "baked") Object.assign(level, { buildPx: band.px, texture: bakedTexture(band.px) });
    const prev = result.at(-1);
    // One instanced draw per technique, except LODs (a different mesh per band).
    if (prev && prev.kind === kind && !(tech === "lod" || tech === "baked")) prev.minPx = minPx;
    else result.push(level);
  });
  if (last < BANDS.length - 1) result.push({ kind: "none", minPx: 0 });
  return result;
}

const server = await createServer({ root, logLevel: "error", server: { port: 5198 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);

const file = new URL("perf.json", out);
const results: Array<Record<string, unknown>> = JSON.parse(await readFile(file, "utf8").catch(() => "[]"));
const done = new Set(results.map((r) => `${r.object}|${r.angle}|${r.range}|${r.active}`));
for (const object of OBJECTS.filter((o) => !only || only.includes(o.id))) {
  const start = Date.now();
  for (const layout of ["hemi", "full"] as const) {
    await page.evaluate(([n, b]) => (window as any).lab.prepare(n, b, { kind: "real" }), [object.id, { layout, frames: layout === "full" ? 16 : 12 }] as const);
    for (const angle of ANGLES)
      for (const [first, last] of RANGES)
        for (const combo of COMBOS) {
          // Combos with an impostor use that layout's bake; the rest are timed once, with hemi.
          const wants = combo.includes("full") ? "full" : "hemi";
          if (wants !== layout) continue;
          for (const active of placements(combo, first, last)) {
            const id = `${object.id}|${angle.id}|${first}-${last}|${active.join(",")}`;
            if (done.has(id)) continue;
            const r = await page.evaluate(([c, l, f, t]) => (window as any).lab.perfChain(c, l, f, t, 30), [object.count, levels(active, first, last), angle.field, !!angle.tumble] as const);
            results.push({ object: object.id, angle: angle.id, range: `${first}-${last}`, active: active.join(","), gpuMs: Math.round(r.medianMs * 1000) / 1000, perLevel: r.perLevel, triangles: r.triangles });
            done.add(id);
            if (results.length % 50 === 0) await writeFile(file, JSON.stringify(results));
          }
        }
    await writeFile(file, JSON.stringify(results));
  }
  console.log(`${object.id.padEnd(11)} ${((Date.now() - start) / 60000).toFixed(1)} min, ${results.length} runs`);
}
await writeFile(file, JSON.stringify(results));
await browser.close();
await server.close();

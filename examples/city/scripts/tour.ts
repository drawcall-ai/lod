// Loads the city in headless Chromium on the real GPU, by default at a 14" MacBook Pro's
// 1512 × 982 CSS pixels at device pixel ratio 2, stops the tour at each of its keys and
// saves a screenshot plus frame times, triangles, draw calls and instances per level to
// .artifacts/<out>/.
//
//   pnpm --filter @drawcall/lod-example-city tour [--size=1512x982] [--dpr=2] [--no-terrain]
//     [--query=debug] [--keys=1,5] [--out=tour] [--cold] [--browser-profile=<dir>]
//
// `ms` is the median of five runs' summed GPU pass durations per frame, sampled
// at stationary keys and while moving. Passes can overlap, so this is not elapsed
// frame time or FPS; `cpu` measures one frame's CPU work.
// Draw calls and triangles are three's counts, which take every indirect draw
// (an InstancedLod's levels) at its full instance count. --no-terrain leaves the ground mesh out, --query adds page URL parameters,
// --keys shoots only those keys; --cold and --browser-profile are in browser.ts.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { args, flag, open, root } from "./browser.ts";
import type { City } from "../src/diagnostics.ts";

type Measure = Awaited<ReturnType<City["measure"]>>;
declare const window: { city: City };

const out = resolve(root, ".artifacts", flag("out") ?? "tour") + "/";
const [width, height] = (flag("size") ?? "1512x982").split("x").map(Number);
const dpr = Number(flag("dpr") ?? 2);
if (!width || !height || !dpr) throw new Error("--size takes <width>x<height> and --dpr a number");
const query = [flag("query"), args.includes("--no-terrain") && "terrain=0"].filter(Boolean).join("&");
const only = flag("keys")?.split(",").map(Number);
// a full run replaces the last one's shots
if (!only) await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const session = await open(5192, { width, height }, dpr);
const page = await session.browser.newPage();
page.on("console", (m) => console.error(`[page ${m.type()}]`, m.text()));
// an error while loading ends the run instead of waiting out the timeout
const failed = new Promise<never>((_, reject) => page.on("pageerror", reject));

try {
  await page.goto(`${session.url}?shot&${query}`);
  await Promise.race([page.waitForFunction(() => "city" in window, null, { timeout: 600_000 }), failed]);
  const loadMs = await page.evaluate(() => window.city.loadMs);
  const keys = await page.evaluate(() => window.city.keys);
  const rows: (Measure & { name: string; time: number; moving: { ms: number; cpu: number } })[] = [];
  for (const [i, key] of keys.entries()) {
    if (only && !only.includes(i + 1)) continue;
    await page.evaluate((t) => window.city.seek(t), key.time);
    // a few real frames: textures upload, fades settle; then untimed ones, so the patches
    // filled around the new pose and their first draws are not in the timing
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
    await page.evaluate(() => window.city.measure(12, 1));
    const measure = await page.evaluate(() => window.city.measure(12, 5));
    const { ms, cpu } = await page.evaluate(() => window.city.measure(12, 5, 1 / 60));
    const moving = { ms, cpu };
    const file = `${String(i + 1).padStart(2, "0")}-${key.name.replace(/\s+/g, "-")}.png`;
    await page.screenshot({ path: out + file });
    rows.push({ ...key, ...measure, moving });
    const m = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
    const levels = measure.kinds.map((k) => `${k.name}: ${k.levels.map((l) => `${m(l.instances)}(${m(l.triangles)})`).join(" ")}`).join(", ");
    const cascades = measure.cascades
      .map((c) => `${c.texel < 0.01 ? `${(c.texel * 1000).toPrecision(2)}mm` : `${c.texel.toPrecision(2)}m`}/${c.casters}`)
      .join(" ");
    console.log(
      `${file.padEnd(24)} ${measure.ms.toFixed(1).padStart(5)} ms (cpu ${measure.cpu.toFixed(1)})  moving ${moving.ms.toFixed(1).padStart(5)} ms (cpu ${moving.cpu.toFixed(1)})  ${(measure.triangles / 1e6).toFixed(2)}M tris  ${measure.calls} draws  shadows ${cascades}  ${levels}`,
    );
  }
  await writeFile(`${out}tour.json`, JSON.stringify({ width, height, dpr, query, loadMs, rows }, null, 2));
  console.log(`load ${(loadMs / 1000).toFixed(1)} s; results in ${out}`);
} finally {
  await session.close();
}

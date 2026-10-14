// Strategy study, step 4: GPU time of every composed strategy (strategy/chains.json) on a
// field of the use case's instance count, each instance drawn by the level its on-screen
// size picks; plus the source asset's memory split for the memory totals.
//
//   npx tsx scripts/strategy-perf.ts [row,row...]
//
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { ROWS } from "./strategy.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = new URL("../../../.artifacts/strategy/", import.meta.url);
const chains: Array<{ row: string; strategy: string; lod: string | null; levels: object[] }> = JSON.parse(await readFile(new URL("chains.json", out), "utf8"));
const only = process.argv[2]?.split(",");

const server = await createServer({ root, logLevel: "error", server: { port: 5194 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);

const file = new URL("perf.json", out);
const results: Array<Record<string, unknown>> = JSON.parse(await readFile(file, "utf8").catch(() => "[]")).filter((r: { row: string }) => only && !only.includes(r.row));
const sources: Record<string, unknown> = {};
for (const row of ROWS.filter((r) => !only || only.includes(r.id))) {
  for (const subject of row.subjects) {
    await page.evaluate(([n, b]) => (window as any).lab.prepare(n, b, { kind: "real" }), [subject, { layout: row.layout, frames: row.layout === "full" ? 16 : 12 }] as const);
    const mem = await page.evaluate(() => (window as any).lab.memory("real"));
    sources[subject] = { totalMB: mem.bytes / 2 ** 20, textureMB: mem.textureBytes / 2 ** 20, triangles: mem.triangles };
    for (const chain of chains.filter((c) => c.row === row.id)) {
      const r = await page.evaluate(([c, l, f, t]) => (window as any).lab.perfChain(c, l, f, t), [row.count, chain.levels, row.field, !!row.tumble] as const);
      results.push({ row: row.id, subject, strategy: chain.strategy, lod: chain.lod, gpuMs: r.medianMs, triangles: r.triangles, perLevel: r.perLevel });
      console.log(`${row.id} ${subject.padEnd(10)} ${chain.strategy.padEnd(22)} ${(chain.lod ?? "").padEnd(10)} ${r.medianMs.toFixed(2)} ms  ${r.perLevel.join("/")}`);
    }
    await writeFile(file, JSON.stringify(results, null, 1));
  }
}
const sourcesFile = new URL("sources.json", out);
const previous = JSON.parse(await readFile(sourcesFile, "utf8").catch(() => "{}"));
await writeFile(sourcesFile, JSON.stringify({ ...previous, ...sources }, null, 1));
await browser.close();
await server.close();

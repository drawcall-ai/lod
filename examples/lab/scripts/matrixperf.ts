// GPU time (timer queries) and extra memory for every row x subject x kind of the matrix.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = new URL(`../../../.artifacts/${process.argv.includes("--set=realistic") ? "matrix-realistic" : "matrix"}/`, import.meta.url);
const { rows } = JSON.parse(await readFile(new URL("index.json", out), "utf8"));
const KINDS: Record<string, { bake: object; mesh: object; mode: string; memo: string }> = {
  "octa-hemi": { bake: { layout: "hemi", frames: 12 }, mesh: {}, mode: "impostor", memo: "octa" },
  "octa-full": { bake: { layout: "full", frames: 17 }, mesh: {}, mode: "impostor", memo: "octa" },
  ring: { bake: { layout: "hemi", frames: 5 }, mesh: { kind: "ring16" }, mode: "impostor", memo: "ring16" },
  cross: { bake: { layout: "hemi", frames: 12 }, mesh: {}, mode: "cross3", memo: "cross3" },
  sprite: { bake: { layout: "hemi", frames: 12 }, mesh: {}, mode: "sprite", memo: "sprite" },
  "lod-simple": { bake: { layout: "hemi", frames: 12 }, mesh: { kind: "lod-simple" }, mode: "proxy", memo: "lod-simple" },
  "lod-baked": { bake: { layout: "hemi", frames: 12 }, mesh: { kind: "lod-baked" }, mode: "proxy", memo: "lod-baked" },
  "lod-4px": { bake: { layout: "hemi", frames: 12 }, mesh: { kind: "lod-simple", errorPx: 4 }, mode: "proxy", memo: "lod-simple" },
  "lod-16px": { bake: { layout: "hemi", frames: 12 }, mesh: { kind: "lod-simple", errorPx: 16 }, mode: "proxy", memo: "lod-simple" },
};
const server = await createServer({ root, logLevel: "error", server: { port: 5183 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);
const only = process.argv.slice(2).find((a) => !a.startsWith("--"))?.split(",");
const onlyRows = process.argv.find((a) => a.startsWith("--rows="))?.split("=")[1]?.split(",");
// Keep earlier results for every row and kind not re-measured now.
const results: Array<Record<string, unknown>> = JSON.parse(await readFile(new URL("perf.json", out), "utf8").catch(() => "[]")).filter(
  (r: { kind: string; row: string }) => (only && !only.includes(r.kind)) || (onlyRows && !onlyRows.includes(r.row)),
);
for (const row of rows.filter((r: { id: string }) => !onlyRows || onlyRows.includes(r.id))) {
  for (const subject of row.subjects)
    for (const [kind, k] of Object.entries(KINDS).filter(([name]) => !only || only.includes(name))) {
      const mesh = kind.startsWith("lod") ? { ...k.mesh, lodError: ((k.mesh as { errorPx?: number }).errorPx ?? 1) / row.views[0].px } : k.mesh;
      await page.evaluate(([n, b, m]) => (window as any).lab.prepare(n, b, m), [subject, k.bake, mesh] as const);
      const mem = await page.evaluate((m) => (window as any).lab.memory(m), k.memo);
      const perf = await page.evaluate(([c, md]) => (window as any).lab.perf(c, md, 40), [row.count, k.mode] as const);
      results.push({ row: row.id, subject, kind, count: row.count, gpuMs: perf.medianMs, memoryMB: mem.bytes / 2 ** 20, triangles: mem.triangles });
      console.log(`${row.id} ${subject.padEnd(8)} ${kind.padEnd(10)} ${Number(perf.medianMs).toFixed(2)} ms  ${(mem.bytes / 2 ** 20).toFixed(2)} MB  ${mem.triangles} tris`);
    }
}
await writeFile(new URL("perf.json", out), JSON.stringify(results, null, 2));
await browser.close();
await server.close();

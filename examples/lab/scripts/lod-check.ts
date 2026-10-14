// Builds simplified and baked mesh LODs in headless Chromium on the real GPU, writes
// contact sheets (original | simple 0.25/0.05/0.01 | baked 0.25/0.05/0.01, three views)
// and baked atlases to .artifacts/lod, and prints a table.
//
//   npx tsx scripts/lod-check.ts [subject,subject...] [--ratios=0.25,0.05,0.01] [--modes=lit,albedo,normal]
//
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith("--"))?.split(",");
const modes = args.find((a) => a.startsWith("--modes="))?.split("=")[1]!.split(",");
const ratios = args.find((a) => a.startsWith("--ratios="))?.split("=")[1]!.split(",").map(Number);
const out = new URL("../../../.artifacts/lod/", import.meta.url);
await mkdir(out, { recursive: true });

const server = await createServer({ root, logLevel: "error", server: { port: 5185, strictPort: false } });
await server.listen();
const url = server.resolvedUrls!.local[0]!;

const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && console.error("[page]", m.text()));
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${url}lod.html`);
await page.waitForFunction(() => "lodCheck" in window);

type Row = Record<string, number | string | object>;
type Result = { name: string; triangles: number; textureBytes: number; simple: Row[]; baked: Row[] };
const report = (await page.evaluate(([o, r, m]) => window.lodCheck.run(o, r, m as never), [only, ratios, modes] as const)) as unknown as {
  renderer: string;
  results: Result[];
  images: Record<string, string>;
};

for (const [name, dataUrl] of Object.entries(report.images)) await writeFile(new URL(`${name}.png`, out), Buffer.from(dataUrl.split(",")[1]!, "base64"));
await writeFile(new URL("report.json", out), JSON.stringify({ renderer: report.renderer, results: report.results }, null, 2));

const mb = (b: number) => `${(b / 1048576).toFixed(1)}MB`;
console.log(report.renderer);
console.log("subject  variant        tris     ms   tex      notes");
for (const r of report.results) {
  console.log(`${r.name.padEnd(8)} original   ${String(r.triangles).padStart(8)}  ${"".padStart(5)}  ${mb(r.textureBytes).padStart(7)}`);
  for (const s of r.simple)
    console.log(`${"".padEnd(8)} simple ${String(s.ratio).padEnd(4)}${String(s.triangles).padStart(8)}  ${String(s.ms).padStart(5)}  ${mb(Number(s.textureBytes)).padStart(7)}  ${JSON.stringify(s.methods)}`);
  for (const b of r.baked)
    console.log(
      `${"".padEnd(8)} baked  ${String(b.ratio).padEnd(4)}${String(b.triangles).padStart(8)}  ${String(Math.round(Number(b.totalMs))).padStart(5)}  ${mb(Number(b.textureBytes)).padStart(7)}  unwrap ${Math.round(Number(b.unwrapMs))}ms bake ${Math.round(Number(b.bakeMs))}ms texels ${b.covered} fallback ${b.fallbacks} maxDist ${Number(b.maxDist).toFixed(3)}`,
    );
}

await browser.close();
await server.close();
console.log(`images: ${fileURLToPath(out)}`);

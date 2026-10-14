// Sun-side view: camera where the sun is. Lit medians (native reference) and an image.
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const out = new URL("../../../.artifacts/sunside/", import.meta.url);
await mkdir(out, { recursive: true });
const server = await createServer({ root, logLevel: "error", server: { port: 5189 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);
await page.evaluate(() => (window as any).lab.setTruthScale(1));
const [names = "tree,pine", mesh = "{}", bake = "{}", tag = "base", extra = "{}"] = process.argv.slice(2);
for (const name of names.split(",")) {
  await page.evaluate(([n, b, m]) => (window as any).lab.prepare(n, JSON.parse(b), JSON.parse(m)), [name, bake, mesh] as const);
  for (const [label, view] of [
    ["sunside", { px: 240, elevation: 40, azimuth: 35, sun: [35, 40] }],
    ["backlit", { px: 240, elevation: 40, azimuth: 215, sun: [35, 40] }],
    ["side", { px: 240, elevation: 20, azimuth: 125, sun: [35, 40] }],
    ["sunhigh", { px: 240, elevation: 10, azimuth: 35, sun: [35, 45] }],
    ["sunhigh2", { px: 240, elevation: 5, azimuth: 35, sun: [35, 60] }],
  ] as const) {
    const r = await page.evaluate((v) => (window as any).lab.compare(v, true), { ...view, ...JSON.parse(extra) });
    console.log(`${name.padEnd(6)} ${label.padEnd(8)} median real ${r.realMedian.toFixed(0)} imp ${r.impMedian.toFixed(0)}  err ${r.error.toFixed(3)}`);
    await writeFile(new URL(`${name}-${label}-${tag}.png`, out), Buffer.from(r.image.split(",")[1], "base64"));
  }
}
await browser.close();
await server.close();

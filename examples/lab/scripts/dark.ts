// Dark-area investigation: share of covered pixels darker than 0.6 x the ground truth's
// median luma, real vs impostor, per size, for a list of variants.
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { port: 5194 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);
const subjects = (process.argv[2] ?? "tree").split(",");
const variants: Array<[string, object, object]> = JSON.parse(process.argv[3] ?? '[["default",{},{}]]');
const fov = +(process.argv[4] ?? 30);
await page.evaluate((k) => (window as any).lab.setTruthScale(k), +(process.env.TRUTH ?? 4));
for (const name of subjects)
  for (const [label, mesh, bake] of variants) {
    await page.evaluate(([n, b, m]) => (window as any).lab.prepare(n, b, m), [name, bake, mesh] as const);
    const row: string[] = [];
    for (const px of [24, 64, 160, 320]) {
      let rd = 0, id = 0, rm = 0, im = 0, k = 0;
      for (const elevation of [5, 25, 50]) for (const azimuth of [20, 110, 200, 290]) {
        const r = await page.evaluate((v) => (window as any).lab.compare(v, false), { px, elevation, azimuth, fov });
        rd += r.realDark; id += r.impDark; rm += r.realMedian; im += r.impMedian; k++;
      }
      row.push(`${px}px dark ${(rd / k * 100).toFixed(1)}%→${(id / k * 100).toFixed(1)}% med ${(rm / k).toFixed(0)}→${(im / k).toFixed(0)}`);
    }
    console.log(`${name.padEnd(6)} ${label.padEnd(14)} ${row.join(" | ")}`);
  }
await browser.close();
await server.close();

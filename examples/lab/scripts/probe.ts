// Quick probe: coverage ratio and error by size for a few subjects and mesh options.
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { port: 5198 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);
const subjects = (process.argv[2] ?? "tree,pine,dead").split(",");
const variants = JSON.parse(process.argv[3] ?? '[{}]');
const bake = JSON.parse(process.argv[4] ?? "{}");
for (const name of subjects)
  for (const mesh of variants) {
    await page.evaluate(([n, b, m]) => (window as any).lab.prepare(n, b, m), [name, bake, mesh]);
    const row: string[] = [];
    for (const px of [12, 24, 48, 96, 192]) {
      let cov = 0, err = 0, bias = 0, k = 0;
      for (const elevation of [5, 30, 60]) for (const azimuth of [20, 140, 260]) {
        const r = await page.evaluate((v) => (window as any).lab.compare(v, false), { px, elevation, azimuth });
        cov += r.coverage; err += r.error; bias += r.bias; k++;
      }
      const st = process.env.STABILITY ? await page.evaluate((v) => (window as any).lab.stability(v), { px, elevation: 20, azimuth: 70 }) : null;
      row.push(`${px}px cov ${(cov / k).toFixed(2)} err ${(err / k).toFixed(3)} b ${(bias / k * 255).toFixed(1)}${st ? ` flk ${st.ratio.toFixed(2)}` : ""}`);
    }
    console.log(`${name.padEnd(7)} ${JSON.stringify(mesh).padEnd(28)} ${row.join(" | ")}`);
  }
await browser.close();
await server.close();

import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { port: 5190 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);
const [names = "tree,pine", bake = "{}", mesh = "{}", size = "512"] = process.argv.slice(2);
for (const name of names.split(",")) {
  await page.evaluate(([n, b, m]) => (window as any).lab.prepare(n, JSON.parse(b), JSON.parse(m)), [name, bake, mesh] as const);
  for (const [col, row] of [[8, 5], [0, 6]]) {
    const r = await page.evaluate(([c, rr, s]) => (window as any).lab.runtimeCheck(c, rr, s), [col, row, +size] as const);
    console.log(name, col, row, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, +(v as number).toFixed(3)])));
  }
}
await browser.close();
await server.close();

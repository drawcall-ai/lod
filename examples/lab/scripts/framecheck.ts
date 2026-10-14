import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { port: 5192 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);
const bake = JSON.parse(process.argv[3] ?? "{}");
for (const name of (process.argv[2] ?? "tree,pine").split(",")) {
  await page.evaluate(([n, b]) => (window as any).lab.prepare(n, b), [name, bake] as const);
  for (const [col, row] of [[8, 5], [5, 5], [0, 6], [11, 3]]) {
    const r = await page.evaluate(([c, rr]) => (window as any).lab.frameCheck(c, rr), [col, row] as const);
    console.log(name, col, row, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(3) : v])));
  }
}
await browser.close();
await server.close();

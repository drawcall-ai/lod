import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { port: 5193 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);
for (const name of (process.argv[2] ?? "tree,pine").split(",")) {
  await page.evaluate((n) => (window as any).lab.prepare(n), name);
  console.log(name, JSON.stringify(await page.evaluate(() => (window as any).lab.inspect())));
}
await browser.close();
await server.close();

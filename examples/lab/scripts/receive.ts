// Sun-side view with shadow maps: real (left) vs impostor (right), receiveShadow off/on.
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const out = new URL("../../../.artifacts/receive/", import.meta.url);
await mkdir(out, { recursive: true });
const server = await createServer({ root, logLevel: "error", server: { port: 5188 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);
for (const name of (process.argv[2] ?? "tree").split(",")) {
  await page.evaluate((n) => (window as any).lab.prepare(n), name);
  for (const receive of [false, true]) {
    const image = await page.evaluate((r) => (window as any).lab.shadows("directional", 384, r, true), receive);
    await writeFile(new URL(`${name}-receive-${receive}.png`, out), Buffer.from(image.split(",")[1], "base64"));
  }
}
await browser.close();
await server.close();

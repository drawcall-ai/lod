// Hand-off check: real + impostor dithered together must cover exactly like the real object.
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const out = new URL("../../../.artifacts/handoff/", import.meta.url);
await mkdir(out, { recursive: true });
const server = await createServer({ root, logLevel: "error", server: { port: 5197 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);
let failed = false;
for (const name of (process.argv[2] ?? "tree,rock,lamp").split(",")) {
  await page.evaluate((n) => (window as any).lab.prepare(n), name);
  for (const amount of [0.2, 0.5, 0.8]) {
    const r = await page.evaluate(([a]) => (window as any).lab.handoff({ px: 128, elevation: 20, azimuth: 60 }, a), [amount]);
    const ok = Math.abs(r.coverage - 1) < 0.08;
    failed ||= !ok;
    console.log(`${name.padEnd(6)} mix ${amount}  coverage ${r.coverage.toFixed(3)}  err ${r.error.toFixed(3)} ${ok ? "ok" : "FAIL"}`);
    await writeFile(new URL(`${name}-${amount}.png`, out), Buffer.from(r.image.split(",")[1], "base64"));
  }
}
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);

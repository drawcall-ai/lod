// Renders real (left) vs impostor (right) casting shadows, for each light type.
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const out = new URL("../../../.artifacts/shadows/", import.meta.url);
await mkdir(out, { recursive: true });
const server = await createServer({ root, logLevel: "error", server: { port: 5196 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
page.on("console", (m) => m.type() === "error" && console.error("[page]", m.text()));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);
for (const name of (process.argv[2] ?? "tree,knot,lamp").split(",")) {
  await page.evaluate((n) => (window as any).lab.prepare(n), name);
  for (const light of ["directional", "point"]) {
    const image = await page.evaluate((l) => (window as any).lab.shadows(l), light);
    await writeFile(new URL(`${name}-${light}.png`, out), Buffer.from(image.split(",")[1], "base64"));
  }
  console.log(name, "done");
}
await browser.close();
await server.close();

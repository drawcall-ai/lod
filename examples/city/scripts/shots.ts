// Renders every viewer item at a close and a medium view in headless Chromium on the real
// GPU and saves PNGs to .artifacts/shots/<item>-<view>.png.
//
//   pnpm --filter @drawcall/lod-example-city shots [item,item...] [--query=seed=9]
//
// --query adds viewer URL parameters.
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

interface Viewer {
  names: string[];
  show(name: string): Promise<{ triangles: number }>;
  view(kind: "close" | "medium"): void;
  settle(): Promise<void>;
}
declare const window: { viewer: Viewer };

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = fileURLToPath(new URL("../.artifacts/shots/", import.meta.url));
await mkdir(out, { recursive: true });
const only = args.find((a) => !a.startsWith("--"))?.split(",");

const server = await createServer({ root, logLevel: "error", server: { port: 5191, strictPort: false } });
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error("vite did not report a local URL");
// new headless: the old headless shell loses every WebGPU device once a page asks for a
// second adapter, as the package's bakes do
const browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--enable-unsafe-webgpu", "--enable-webgpu-developer-features", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.error("[page]", e.message));
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && console.error(`[page ${m.type()}]`, m.text()));

try {
  await page.goto(`${url}viewer.html?shot&${flag("query") ?? ""}`);
  await page.waitForFunction(() => "viewer" in window, null, { timeout: 120_000 });
  const names = only ?? (await page.evaluate(() => window.viewer.names));
  for (const name of names) {
    const { triangles } = await page.evaluate((n) => window.viewer.show(n), name);
    for (const kind of ["close", "medium"] as const) {
      await page.evaluate((k) => window.viewer.view(k), kind);
      await page.evaluate(() => window.viewer.settle());
      await page.screenshot({ path: `${out}${name}-${kind}.png` });
    }
    console.log(`${name.padEnd(24)} ${triangles.toLocaleString().padStart(12)} triangles`);
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`shots: ${out}`);

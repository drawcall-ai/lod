// What the scripts share: the city's dev server and a headless Chromium on the real GPU.
// Every script takes
//
//   --cold                    empty the browser profile and public/_vitecache first, so
//                             derived levels and asset caches rebuild
//   --browser-profile=<dir>   the profile (relative to the example), default .artifacts/browser;
//                             a profile of its own keeps the page's bake cache between runs
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext } from "@playwright/test";
import { createServer } from "vite";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const args = process.argv.slice(2);
export const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

export interface Session {
  url: string;
  browser: BrowserContext;
  close(): Promise<void>;
}

/** Starts Vite on `port` (or the next free one) and Chromium with WebGPU at `viewport` CSS pixels. */
export async function open(port: number, viewport: { width: number; height: number }, deviceScaleFactor = 1): Promise<Session> {
  const profile = resolve(root, flag("browser-profile") ?? ".artifacts/browser");
  if (args.includes("--cold")) {
    await rm(profile, { recursive: true, force: true });
    await rm(resolve(root, "public/_vitecache"), { recursive: true, force: true });
    await mkdir(resolve(root, "public/_vitecache"));
  }
  const server = await createServer({ root, logLevel: "error", server: { port, strictPort: false } });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("vite did not report a local URL");
  const browser = await chromium.launchPersistentContext(profile, {
    // new headless: the old headless shell loses every WebGPU device once a page asks for a
    // second adapter, as the package's bakes do
    channel: "chromium",
    headless: true,
    viewport,
    deviceScaleFactor,
    args: ["--enable-unsafe-webgpu", "--enable-webgpu-developer-features", "--enable-gpu", "--ignore-gpu-blocklist"],
  });
  return {
    url,
    browser,
    async close() {
      await browser.close();
      await server.close();
    },
  };
}

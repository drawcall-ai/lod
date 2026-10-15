// What every script shares: the lab served by Vite, one of its pages open in headless
// Chromium on the real GPU, and a place for the images it writes.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { createServer } from "vite";
import { must } from "../src/must.ts";

/**
 * Opens lab page `path` and waits for it to publish `window[api]`. Page errors and
 * warnings are forwarded to stderr. `close` ends browser and server.
 */
export async function open(path: string, api: string): Promise<{ page: Page; close(): Promise<void> }> {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    logLevel: "error",
    // No reloads mid-run when sources change.
    server: { port: 5200, strictPort: false, hmr: false, watch: null },
  });
  await server.listen();
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
  const close = async () => {
    await browser.close();
    await server.close();
  };
  try {
    const page = await browser.newPage();
    page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && console.error("[page]", m.text()));
    page.on("pageerror", (e) => console.error("[page]", e.message));
    await page.goto(`${must(server.resolvedUrls?.local[0], "dev server URL")}${path}`);
    await page.waitForFunction((name) => name in window, api);
    return { page, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The directory .artifacts/`name` at the repository root, created. */
export async function artifacts(name: string): Promise<URL> {
  const dir = new URL(`../../../.artifacts/${name}/`, import.meta.url);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Writes PNG data URL `image` as `name`.png into `dir`. */
export async function savePng(dir: URL, name: string, image: string): Promise<void> {
  await writeFile(new URL(`${name}.png`, dir), Buffer.from(must(image.split(",")[1], "PNG data"), "base64"));
}

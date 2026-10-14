// Loads every realistic case through GLTSLoader, bakes it, writes the impostor as
// public/cases/<id>/<id>.impostor.glts, loads that back through GLTSLoader and checks
// it carries the same bake, and renders one comparison. The check runs on a fresh server:
// Vite's dev server caches file sizes, so a file rewritten under it is served truncated.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = new URL("../../../.artifacts/cases/", import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
async function open() {
  const server = await createServer({ root, logLevel: "error", server: { port: 5186 } });
  await server.listen();
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("[page]", e.message));
  page.on("console", (m) => m.type() !== "log" && console.log(`[${m.type()}]`, m.text()));
  await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
  await page.waitForFunction(() => "lab" in window);
  return { server, page };
}
const ids = process.argv[2]?.split(",") ?? ["oak", "ash", "spruce", "quiver", "shrub", "rooibos", "fern02", "boulder", "rock07", "cliffstone", "moonrock", "car", "barrel", "streetlamp"];
const hashes: Record<string, string> = {};
let { server, page } = await open();
for (const id of ids) {
  try {
    // The asteroid case ships the full sphere; everything else the upper hemisphere.
    const info = await page.evaluate(([n, b]) => (window as any).lab.prepare(n, b), [id, id === "moonrock" ? { layout: "full", frames: 16 } : {}] as const);
    // The deliverable: the impostor as a .glts next to the case, then loaded back through GLTSLoader.
    const glts = await page.evaluate(() => (window as any).lab.exportGlts());
    await writeFile(new URL(`../public/cases/${id}/${id}.impostor.glts`, import.meta.url), glts);
    hashes[id] = await page.evaluate(() => (window as any).lab.bakeHash());
    const r = await page.evaluate(() => (window as any).lab.compare({ px: 300, elevation: 15, azimuth: 30 }, true));
    await writeFile(new URL(`${id}.png`, out), Buffer.from(r.image.split(",")[1], "base64"));
    console.log(id.padEnd(11), `bake ${info.bakeMs} ms`, `${info.encodedKB} KB`, `glts ${(glts.length / 1024).toFixed(0)} KB`, `error ${r.error.toFixed(3)}`);
  } catch (e) {
    console.log(id, "FAILED", (e as Error).message.slice(0, 300));
  }
}
await page.close();
await server.close();
({ server, page } = await open());
for (const id of Object.keys(hashes)) {
  const loaded = await page.evaluate((u) => (window as any).lab.checkGlts(u), `/cases/${id}/${id}.impostor.glts`).catch((e: Error) => e.message.slice(0, 300));
  console.log(id.padEnd(11), loaded === hashes[id] ? "glts loads through GLTSLoader, same bake" : `GLTS MISMATCH ${loaded}`);
}
await browser.close();
await server.close();

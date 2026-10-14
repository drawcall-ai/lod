// Block compression experiment: the same bake as RGBA8 vs Basis UASTC / UASTC+RDO / ETC1S
// (transcoded for this GPU), compared against the 4x truth at three sizes.
import { writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
const out = new URL("../../../.artifacts/bc/", import.meta.url);
const server = await createServer({ root: process.cwd(), logLevel: "error", server: { port: 5200 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
page.on("console", (m) => m.type() === "error" && console.error("[console]", m.text().slice(0, 200)));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);
const VIEWS = [{ px: 300, elevation: 10, azimuth: 30 }, { px: 100, elevation: 10, azimuth: 30 }, { px: 30, elevation: 10, azimuth: 30 }];
const rows: Array<Record<string, unknown>> = [];
for (const subject of ["oak", "boulder", "barrel", "grass", "car"]) {
  for (const codec of ["rgba8", "uastc", "uastc-rdo", "etc1s"]) {
    await page.evaluate(([n]) => (window as any).lab.prepare(n, { layout: "full" }), [subject] as const);
    const info = codec === "rgba8" ? null : await page.evaluate((c) => (window as any).lab.compress(c), codec);
    const errors: number[] = [];
    for (const [v, view] of VIEWS.entries()) {
      const r = await page.evaluate((vv) => (window as any).lab.compare(vv, true), view);
      errors.push(r.error);
      await writeFile(new URL(`${subject}-${view.px}-${codec}.png`, out), Buffer.from(r.image.split(",")[1], "base64"));
    }
    rows.push({ subject, codec, errors, ...(info ?? {}) });
    console.log(subject.padEnd(8), codec.padEnd(10), errors.map((e) => e.toFixed(4)).join(" "), info ? `file ${(info.fileBytes / 2 ** 20).toFixed(2)} MB (zlib RGBA8 ${(info.zlibBytes / 2 ** 20).toFixed(2)}) · GPU ${(info.gpuBytes / 2 ** 20).toFixed(1)} MB (RGBA8 ${(info.rgba8GpuBytes / 2 ** 20).toFixed(1)}) · encode ${(info.encodeMs / 1000).toFixed(1)} s · ${info.formats.join(",")}` : "");
  }
}
await writeFile(new URL("results.json", out), JSON.stringify(rows, null, 1));
await browser.close(); await server.close(); process.exit(0);

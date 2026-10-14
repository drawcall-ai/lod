// Lit comparison at views exactly on baked frames with a near-orthographic camera.
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { port: 5191 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);
const name = process.argv[2] ?? "tree";
const variants: Array<[string, object]> = JSON.parse(process.argv[3] ?? '[["default",{}]]');
// hemi 12-frame directions (col,row) -> elevation/azimuth in the lab's convention
const views = [[8, 5], [5, 5], [0, 6], [11, 3], [6, 6]].map(([c, r]) => {
  const u = c! / 11, v = r! / 11;
  let x = u - v, z = u + v - 1, y = 1 - Math.abs(x) - Math.abs(z);
  const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
  return { elevation: (Math.asin(y) * 180) / Math.PI, azimuth: (Math.atan2(x, z) * 180) / Math.PI };
});
for (const [label, mesh] of variants) {
  await page.evaluate(([n, m]) => (window as any).lab.prepare(n, { supersample: 4 }, m), [name, mesh] as const);
  let rm = 0, im = 0, err = 0;
  for (const v of views) {
    const r = await page.evaluate((vv) => (window as any).lab.compare(vv, false), { ...v, px: 256, fov: 2 });
    rm += r.realMedian; im += r.impMedian; err += r.error;
  }
  console.log(`${label.padEnd(16)} median real ${(rm / views.length).toFixed(1)} imp ${(im / views.length).toFixed(1)} err ${(err / views.length).toFixed(3)}`);
}
await browser.close();
await server.close();

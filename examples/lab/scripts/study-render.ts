// Technique study, step 1: every object × angle × band × technique against the 4x
// supersampled truth, plus each technique's memory. Writes .artifacts/study/cells/ and
// metrics.json.
//
//   npx tsx scripts/study-render.ts [object,object...]
//
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { ANGLES, BANDS, OBJECTS, TECHS, prepareArgs } from "./study-config.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = new URL("../../../.artifacts/study/", import.meta.url);
await mkdir(new URL("cells/", out), { recursive: true });
const only = process.argv[2]?.split(",");

const server = await createServer({ root, logLevel: "error", server: { port: 5197 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);
await page.evaluate(() => (window as any).lab.setTruthScale(4));

const file = new URL("metrics.json", out);
const metrics: Array<Record<string, unknown>> = JSON.parse(await readFile(file, "utf8").catch(() => "[]"));
for (const object of OBJECTS.filter((o) => !only || only.includes(o.id))) {
  const start = Date.now();
  for (const tech of TECHS)
    for (const band of BANDS) {
      const [bake, mesh] = prepareArgs(tech, band);
      await page.evaluate(([n, b, m]) => (window as any).lab.prepare(n, b, m), [object.id, bake, mesh] as const);
      const mem = await page.evaluate((k) => (window as any).lab.memory(k), tech === "hemi" || tech === "full" ? "octa" : (mesh as { kind: string }).kind);
      for (const angle of ANGLES) {
        const view = { elevation: angle.elevation, azimuth: angle.azimuth, rotation: angle.rotation, px: band.px, fov: band.fov, ...(band.close ? (object.enterable ? { distance: 0.6 } : { outside: 0.15 }) : {}) };
        const r = await page.evaluate((v) => (window as any).lab.compare(v, true), view);
        const cell = `cells/${object.id}-${angle.id}-${band.id}-${tech}.png`;
        await writeFile(new URL(cell, out), Buffer.from(r.image.split(",")[1], "base64"));
        const entry = { object: object.id, angle: angle.id, band: band.id, tech, file: cell, error: r.error, iou: r.iou, memoryMB: mem.bytes / 2 ** 20, textureMB: (mem.textureBytes ?? 0) / 2 ** 20, triangles: mem.triangles };
        const i = metrics.findIndex((m) => m.object === object.id && m.angle === angle.id && m.band === band.id && m.tech === tech);
        if (i >= 0) metrics[i] = entry;
        else metrics.push(entry);
      }
    }
  await writeFile(file, JSON.stringify(metrics, null, 1));
  console.log(`${object.id.padEnd(11)} ${((Date.now() - start) / 1000).toFixed(0)} s`);
}
await browser.close();
await server.close();

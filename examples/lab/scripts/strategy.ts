// Strategy study, step 1: every representation of every realistic case at every
// on-screen size, against the 4x supersampled truth. Strategies (real only, LOD then
// impostor, ...) are composed from these cells by scripts/strategy-compose.py.
//
//   npx tsx scripts/strategy.ts [row,row...]
//
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = new URL("../../../.artifacts/strategy/", import.meta.url);
await mkdir(new URL("cells/", out), { recursive: true });

/** On-screen sizes (bounding-sphere diameter in px), a factor of 2 apart. */
export const SIZES = [400, 200, 100, 50, 25];
export const REPS = ["real", "lod-simple", "lod-baked", "octa"] as const;

interface Row {
  id: string;
  title: string;
  subjects: string[];
  /** the camera angle of this use case */
  view: { elevation: number; azimuth: number; rotation?: [number, number, number] };
  /** the on-screen sizes this use case actually shows */
  range: [number, number];
  count: number;
  /** perf field camera: 0 = ground level, else degrees above the horizon */
  field: number;
  tumble?: boolean;
  layout: "hemi" | "full";
}

export const ROWS: Row[] = [
  { id: "A", title: "Broadleaf forest, walking player", subjects: ["oak", "ash", "quiver"], view: { elevation: 3, azimuth: 20 }, range: [400, 25], count: 50_000, field: 0, layout: "hemi" },
  { id: "B", title: "Forest from a drone", subjects: ["oak", "spruce"], view: { elevation: 55, azimuth: 30 }, range: [200, 25], count: 50_000, field: 55, layout: "hemi" },
  { id: "C", title: "Conifer ridge on the horizon", subjects: ["spruce", "oak"], view: { elevation: 3, azimuth: 40 }, range: [50, 25], count: 100_000, field: 0, layout: "hemi" },
  { id: "D", title: "Boulder field", subjects: ["boulder", "rock07", "cliffstone"], view: { elevation: 12, azimuth: 40 }, range: [400, 25], count: 5_000, field: 0, layout: "hemi" },
  { id: "E", title: "Understory around the player", subjects: ["shrub", "rooibos", "fern02"], view: { elevation: 30, azimuth: 30 }, range: [400, 50], count: 200_000, field: 0, layout: "hemi" },
  { id: "F", title: "Village props", subjects: ["car", "barrel", "streetlamp"], view: { elevation: 10, azimuth: 35 }, range: [400, 25], count: 2_000, field: 0, layout: "hemi" },
  { id: "G", title: "Asteroid belt, tumbling", subjects: ["moonrock", "boulder"], view: { elevation: -40, azimuth: 70, rotation: [40, 20, 110] }, range: [400, 25], count: 10_000, field: 0, tumble: true, layout: "full" },
];

/** Baked-LOD texture: about two texels per screen pixel, as a tuned bake would use. */
export const bakedTexture = (px: number) => Math.min(1024, Math.max(64, 2 ** Math.ceil(Math.log2(px * 2))));

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv[2]?.split(",");
  const server = await createServer({ root, logLevel: "error", server: { port: 5192 } });
  await server.listen();
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("[page]", e.message));
  await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
  await page.waitForFunction(() => "lab" in window);
  await page.evaluate(() => (window as any).lab.setTruthScale(4));
  const metricsFile = new URL("metrics.json", out);
  const metrics: Array<Record<string, unknown>> = JSON.parse(await readFile(metricsFile, "utf8").catch(() => "[]"));
  for (const row of ROWS.filter((r) => !only || only.includes(r.id))) {
    for (const subject of row.subjects) {
      const bake = { layout: row.layout, frames: row.layout === "full" ? 16 : 12 };
      for (const px of SIZES) {
        for (const rep of REPS) {
          const mesh =
            rep === "octa" ? {}
            : rep === "real" ? { kind: "real" }
            : { kind: rep, lodError: 1 / px, texture: bakedTexture(px) };
          await page.evaluate(([n, b, m]) => (window as any).lab.prepare(n, b, m), [subject, bake, mesh] as const);
          const mem = await page.evaluate((k) => (window as any).lab.memory(k), rep === "octa" ? "octa" : rep);
          const r = await page.evaluate((v) => (window as any).lab.compare(v, true), { ...row.view, px });
          const file = `cells/${row.id}-${subject}-${px}-${rep}.png`;
          await writeFile(new URL(file, out), Buffer.from(r.image.split(",")[1], "base64"));
          const i = metrics.findIndex((m) => m.row === row.id && m.subject === subject && m.px === px && m.rep === rep);
          const entry = { row: row.id, subject, px, rep, file, error: r.error, iou: r.iou, memoryMB: mem.bytes / 2 ** 20, triangles: mem.triangles };
          if (i >= 0) metrics[i] = entry;
          else metrics.push(entry);
        }
        console.log(`${row.id} ${subject.padEnd(10)} ${px}`);
      }
      await writeFile(metricsFile, JSON.stringify(metrics, null, 1));
    }
  }
  await writeFile(new URL("index.json", out), JSON.stringify({ rows: ROWS, sizes: SIZES, reps: REPS }, null, 2));
  await browser.close();
  await server.close();
}

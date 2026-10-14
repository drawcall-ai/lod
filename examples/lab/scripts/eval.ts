// Drives the lab in headless Chromium on the real GPU and writes comparison images
// and a JSON report to .artifacts/eval.
//
//   npx tsx scripts/eval.ts [subject,subject...] [--perf] [--views=quick|full] [--tag=name]
//
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}`))?.split("=")[1] ?? (args.includes(`--${name}`) ? "1" : undefined);
const only = args.find((a) => !a.startsWith("--"))?.split(",");
const tag = flag("tag") ?? "latest";
const bakeOptions = JSON.parse(flag("bake") ?? "{}");
const meshOptions = JSON.parse(flag("mesh") ?? "{}");
const out = new URL(`../../../.artifacts/eval/${tag}/`, import.meta.url);
await mkdir(out, { recursive: true });

const server = await createServer({ root, logLevel: "error", server: { port: 5199, strictPort: false } });
await server.listen();
const url = server.resolvedUrls!.local[0]!;

const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("console", (m) => m.type() === "error" && console.error("[page]", m.text()));
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${url}?auto`);
await page.waitForFunction(() => "lab" in window);

type Lab = {
  subjects: Array<{ name: string; why: string }>;
  prepare(name: string, bake?: object, options?: object): Promise<Record<string, unknown>>;
  compare(view: object, image?: boolean): { iou: number; error: number; colourError: number; image: string };
  atlas(): Record<string, string>;
  perf(count: number, mode: string, frames?: number): Promise<Record<string, number | string>>;
  info(): { renderer: string };
};

const views =
  flag("views") === "full"
    ? [24, 48, 96, 192].flatMap((px) => [0, 12, 30, 55, 85].flatMap((elevation) => [0, 17, 41, 77, 133, 199, 262, 311].map((azimuth) => ({ px, elevation, azimuth }))))
    : [48, 128].flatMap((px) => [2, 25, 60].flatMap((elevation) => [17, 133, 262].map((azimuth) => ({ px, elevation, azimuth }))));

const save = (name: string, dataUrl: string) => writeFile(new URL(name, out), Buffer.from(dataUrl.split(",")[1]!, "base64"));

const info = await page.evaluate(() => (window.lab as Lab).info());
console.log(info.renderer);
const names = (await page.evaluate(() => (window.lab as Lab).subjects)).map((s) => s.name).filter((n) => !only || only.includes(n));
const report: Record<string, unknown> = { renderer: info.renderer, subjects: {} };

for (const name of names) {
  const prepared = await page.evaluate(([n, b, m]) => (window.lab as Lab).prepare(n, b, m), [name, bakeOptions, meshOptions] as const);
  const atlas = await page.evaluate(() => (window.lab as Lab).atlas());
  await save(`${name}-atlas-base.png`, atlas.base!);
  await save(`${name}-atlas-normal.png`, atlas.normalDepth!);
  await save(`${name}-atlas-depth.png`, atlas["normalDepth.a"]!);

  const scores: Array<{ px: number; elevation: number; azimuth: number; iou: number; error: number; colourError: number }> = [];
  for (const view of views) {
    const r = await page.evaluate((v) => (window.lab as Lab).compare(v, true), view);
    scores.push({ ...view, iou: r.iou, error: r.error, colourError: r.colourError });
    // One image per size/elevation keeps the folder browsable.
    if (view.azimuth === 133 || flag("images") === "all")
      await save(`${name}-px${view.px}-el${view.elevation}-az${view.azimuth}.png`, r.image);
  }
  // Tricky transforms: lying down, mirrored and stretched instances.
  const transformed = [
    { px: 128, elevation: 30, azimuth: 40, rotation: [0, 0, 90] },
    { px: 128, elevation: 30, azimuth: 40, rotation: [25, 60, -15], scale: [1, 1.6, 1] },
    { px: 128, elevation: 15, azimuth: 200, scale: [-1, 1, 1] },
    { px: 128, elevation: 30, azimuth: 40, sun: [220, 12] },
  ];
  const special: Array<{ iou: number; error: number }> = [];
  for (const [i, view] of transformed.entries()) {
    const r = await page.evaluate((v) => (window.lab as Lab).compare(v, true), view);
    special.push({ ...view, iou: r.iou, error: r.error });
    await save(`${name}-special${i}.png`, r.image);
  }
  const mean = (k: "iou" | "error") => scores.reduce((s, x) => s + x[k], 0) / scores.length;
  const worst = [...scores].sort((a, b) => b.error - a.error).slice(0, 3);
  const summary = { ...prepared, meanIou: mean("iou"), meanError: mean("error"), worst, special };
  (report.subjects as Record<string, unknown>)[name] = { summary, scores };
  console.log(
    `${name.padEnd(9)} bake ${String(prepared.bakeMs).padStart(5)}ms  ${String(prepared.encodedKB).padStart(5)}KB  iou ${mean("iou").toFixed(3)}  err ${mean("error").toFixed(4)}  worst ${worst[0]!.error.toFixed(3)}@${worst[0]!.px}px/${worst[0]!.elevation}°/${worst[0]!.azimuth}°  special ${special.map((s) => s.error.toFixed(3)).join(" ")}`,
  );

  if (flag("perf")) {
    for (const count of [10_000, 100_000]) {
      const real = await page.evaluate((c) => (window.lab as Lab).perf(c, "real"), count);
      const imp = await page.evaluate((c) => (window.lab as Lab).perf(c, "impostor"), count);
      console.log(`  perf ${count}: real ${Number(real.medianMs).toFixed(2)}ms (${(Number(real.triangles) / 1e6).toFixed(1)}M tris)  impostor ${Number(imp.medianMs).toFixed(2)}ms`);
      (report.subjects as Record<string, Record<string, unknown>>)[name]![`perf${count}`] = { real, impostor: imp };
    }
  }
}

await writeFile(new URL("report.json", out), JSON.stringify(report, null, 2));
await browser.close();
await server.close();
console.log(`report: ${fileURLToPath(out)}`);

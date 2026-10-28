// Plays the city's tour live in headless Chromium on the real GPU and reports what the
// project promises: a short load, then no hitches. Prints the load time, the files
// fetched before the first frame, and every frame after it that took longer than two
// display intervals, plus the browser's long tasks.
//
//   pnpm --filter @drawcall/lod-example-city smooth [--seconds=60] [--cold]
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

interface Probe {
  started: number;
  frames: number[];
  tasks: { start: number; duration: number }[];
}
declare const window: { city: { loadMs: number; loadStages: Record<string, number> }; probe: Probe };

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const seconds = Number(args.find((a) => a.startsWith("--seconds="))?.slice(10) ?? 60);
const server = await createServer({ root, logLevel: "error", server: { port: 5193, strictPort: false } });
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error("vite did not report a local URL");
const profile = resolve(root, args.find((arg) => arg.startsWith("--browser-profile="))?.slice(18) ?? ".artifacts/browser");
if (args.includes("--cold")) await rm(profile, { recursive: true, force: true });
const browser = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1512, height: 982 },
  deviceScaleFactor: 2,
  args: ["--enable-unsafe-webgpu", "--enable-webgpu-developer-features", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
const output = resolve(root, args.find((a) => a.startsWith("--out="))?.slice(6) ?? ".artifacts") + "/";
await mkdir(output, { recursive: true });
const profiler = args.includes("--profile") ? await page.context().newCDPSession(page) : undefined;
page.on("console", (m) => console.error(`[page ${m.type()}]`, m.text()));
const responses: Promise<void>[] = [];
page.on("response", (response) => {
  if (response.status() >= 500) responses.push(response.text().then((body) => console.error(`[HTTP ${response.status()}] ${response.url()}: ${body}`)));
});
const failed = new Promise<never>((_, reject) => page.on("pageerror", reject));
const fetched: string[] = [];
let loaded = false;
const late: string[] = [];
page.on("request", (r) => {
  const path = new URL(r.url()).pathname;
  if (!/\.(glb|gltf|glts|ktx2|bin|jpg|png|hdr|exr|zip)$|_vitecache/.test(path)) return;
  (loaded ? late : fetched).push(path);
});
try {
  if (profiler) await profiler.send("Profiler.enable");
  await page.goto(url);
  await Promise.race([page.waitForFunction(() => "city" in window, null, { timeout: 600_000 }), failed]);
  loaded = true;
  const loadMs = await page.evaluate(() => window.city.loadMs);
  const loadStages = await page.evaluate(() => window.city.loadStages);
  let profileStarted: number | undefined;
  if (profiler) {
    profileStarted = await page.evaluate(() => performance.now());
    await profiler.send("Profiler.start");
  }
  await page.evaluate(() => {
    const probe: Probe = { started: performance.now(), frames: [], tasks: [] };
    window.probe = probe;
    let last = performance.now();
    const tick = (now: number) => {
      probe.frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) probe.tasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: false });
  });
  await Promise.race([page.waitForTimeout(seconds * 1000), failed]);
  const probe = await page.evaluate(() => window.probe);
  await writeFile(`${output}smooth.json`, JSON.stringify({ loadMs, loadStages, fetched, late, profileStarted, ...probe }, null, 2));
  if (profiler) {
    const { profile } = await profiler.send("Profiler.stop");
    await writeFile(`${output}smooth.cpuprofile`, JSON.stringify(profile));
  }
  const sorted = [...probe.frames].sort((a, b) => a - b);
  const interval = sorted[Math.floor(sorted.length / 2)] ?? 16.7;
  const hitches = probe.frames.filter((ms) => ms > 2 * interval);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]?.toFixed(1);
  console.log(`load ${(loadMs / 1000).toFixed(2)} s`);
  console.log(`load stages (ms): ${JSON.stringify(loadStages)}`);
  console.log(`fetched before first frame (${fetched.length}):\n  ${fetched.join("\n  ")}`);
  console.log(`fetched after (${late.length}):\n  ${late.join("\n  ")}`);
  console.log(`frames ${probe.frames.length}, median ${interval.toFixed(1)} ms, p99 ${pct(0.99)} ms, max ${sorted.at(-1)?.toFixed(1)} ms`);
  console.log(`frames > 33 ms: ${probe.frames.filter((ms) => ms > 33).length}`);
  console.log(`hitches (> ${(2 * interval).toFixed(0)} ms): ${hitches.length}  [${hitches.map((ms) => ms.toFixed(0)).join(", ")}]`);
  const long = probe.tasks.sort((a, b) => b.duration - a.duration);
  console.log(
    `long tasks: ${long.length}, total ${long.reduce((s, t) => s + t.duration, 0).toFixed(0)} ms, worst [${long
      .slice(0, 10)
      .map((t) => t.duration.toFixed(0))
      .join(", ")}]`,
  );
} finally {
  await Promise.allSettled(responses);
  await browser.close();
  await server.close();
}

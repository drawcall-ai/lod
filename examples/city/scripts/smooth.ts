// Plays the city's tour live in headless Chromium on the real GPU and reports what the
// project promises: a short load, then no hitches. Prints the load time, the files
// fetched before the first frame, and every frame after it that took longer than two
// display intervals, plus the browser's long tasks.
//
//   pnpm --filter @drawcall/lod-example-city smooth [--seconds=60] [--out=.artifacts] [--trace]
//     [--cold] [--browser-profile=<dir>]
//
// --cold and --browser-profile are in browser.ts.
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { Request } from "@playwright/test";
import { args, flag, open, root } from "./browser.ts";
import type { City } from "../src/diagnostics.ts";

interface Probe {
  started: number;
  frames: number[];
  tasks: { start: number; duration: number }[];
}
declare const window: { city: City; probe: Probe };

const seconds = Number(flag("seconds") ?? 60);
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--seconds must be a positive number");
const session = await open(5193, { width: 1512, height: 982 }, 2);
const page = await session.browser.newPage();
const output = resolve(root, flag("out") ?? ".artifacts") + "/";
await mkdir(output, { recursive: true });
const profiler = args.includes("--trace") ? await page.context().newCDPSession(page) : undefined;
const trace = args.includes("--trace") ? createGzip() : undefined;
const traceFile = trace?.pipe(createWriteStream(`${output}smooth.trace.json.gz`));
trace?.write('{"traceEvents":[');
let firstTrace = true;
profiler?.on("Tracing.dataCollected", ({ value }: { value: unknown[] }) => {
  if (!trace || !value.length) return;
  const events = value.map((event) => JSON.stringify(event));
  trace.write(`${firstTrace ? "" : ","}${events.join(",")}`);
  firstTrace = false;
});
page.on("console", (m) => console.error(`[page ${m.type()}]`, m.text()));
page.on("websocket", (socket) =>
  socket.on("framereceived", ({ payload }) => {
    if (typeof payload === "string" && payload.includes('"full-reload"')) console.error(`[reload] ${payload}`);
  }),
);
const responses: Promise<void>[] = [];
page.on("response", (response) => {
  const status = response.status();
  if (status < 400) return;
  if (status < 500) console.error(`[HTTP ${status}] ${response.url()}`);
  else responses.push(response.text().then((body) => console.error(`[HTTP ${status}] ${response.url()}: ${body}`)));
});
const failed = new Promise<never>((_, reject) => page.on("pageerror", reject));
const requests: { request: Request; path: string }[] = [];
page.on("request", (r) => {
  const requested = new URL(r.url());
  const path = requested.pathname;
  if (!/\.(glb|gltf|glts|ktx2|bin|jpg|png|webp|hdr|exr|zip)$|_vitecache/.test(path)) return;
  requests.push({ request: r, path: path + requested.search });
});
try {
  if (profiler)
    await profiler.send("Tracing.start", {
      traceConfig: { recordMode: "recordAsMuchAsPossible", includedCategories: ["blink.user_timing", "devtools.timeline", "gpu"] },
    });
  await page.goto(session.url);
  await Promise.race([page.waitForFunction(() => "city" in window, null, { timeout: 600_000 }), failed]);
  const firstFrame = await page.evaluate(() => {
    const frame = performance.getEntriesByName("city:first frame")[0];
    if (!frame) throw new Error("Missing first-frame timing");
    return performance.timeOrigin + frame.startTime;
  });
  const loadMs = await page.evaluate(() => window.city.loadMs);
  const loadStages = await page.evaluate(() => window.city.loadStages);
  console.log(`load ${(loadMs / 1000).toFixed(2)} s`);
  console.log(`load stages (ms): ${JSON.stringify(loadStages)}`);
  await page.evaluate((firstFrame) => {
    const probe: Probe = { started: firstFrame - performance.timeOrigin, frames: [], tasks: [] };
    performance.mark("smooth:start");
    window.probe = probe;
    let last: number | undefined;
    const tick = (now: number) => {
      if (last !== undefined) probe.frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.startTime >= probe.started) probe.tasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: true });
  }, firstFrame);
  await Promise.race([page.waitForTimeout(seconds * 1000), failed]);
  const probe = await page.evaluate(() => window.probe);
  if (!probe) throw new Error("The page reloaded during measurement; repeat the run without source edits or dependency optimization");
  const fetched: string[] = [],
    late: string[] = [];
  for (const { request, path } of requests) (request.timing().startTime <= firstFrame ? fetched : late).push(path);
  const sources = fetched.filter((path) => /\.(glb|gltf|glts)(?:\?|$)/.test(path));
  await writeFile(`${output}smooth.json`, JSON.stringify({ loadMs, loadStages, fetched, late, sources, ...probe }, null, 2));
  if (profiler) {
    const completed = new Promise<void>((resolve) => profiler.once("Tracing.tracingComplete", () => resolve()));
    await profiler.send("Tracing.end");
    await completed;
    trace?.end("]}");
    if (traceFile) await finished(traceFile);
  }
  const sorted = [...probe.frames].sort((a, b) => a - b);
  const interval = sorted[Math.floor(sorted.length / 2)] ?? 16.7;
  const hitches = probe.frames.filter((ms) => ms > 2 * interval);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]?.toFixed(1);
  console.log(`source assets before first frame: ${sources.length}${sources.length ? ` [${sources.join(", ")}]` : ""}`);
  console.log(`fetched before first frame (${fetched.length}):\n  ${fetched.join("\n  ")}`);
  console.log(`fetched after (${late.length}):\n  ${late.join("\n  ")}`);
  console.log(`frames ${probe.frames.length}, median ${interval.toFixed(1)} ms, p99 ${pct(0.99)} ms, max ${sorted.at(-1)?.toFixed(1)} ms`);
  console.log(`frames > 33 ms: ${probe.frames.filter((ms) => ms > 33).length}`);
  console.log(`hitches (> ${(2 * interval).toFixed(0)} ms): ${hitches.length}  [${hitches.map((ms) => ms.toFixed(0)).join(", ")}]`);
  console.log(`tasks > 100 ms: ${probe.tasks.filter(({ duration }) => duration > 100).length}`);
  const long = probe.tasks.sort((a, b) => b.duration - a.duration);
  console.log(
    `long tasks: ${long.length}, total ${long.reduce((s, t) => s + t.duration, 0).toFixed(0)} ms, worst [${long
      .slice(0, 10)
      .map((t) => t.duration.toFixed(0))
      .join(", ")}]`,
  );
} finally {
  await Promise.allSettled(responses);
  await session.close();
}

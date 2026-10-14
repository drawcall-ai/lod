// GPU time per proxy kind (timer queries), 10k and 100k instances of one subject.
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { port: 5186 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);
const name = process.argv[2] ?? "tree";
const runs: Array<[string, object, object, string]> = [
  ["hemi12", {}, {}, "impostor"],
  ["full17", { layout: "full", frames: 17 }, {}, "impostor"],
  ["ring16", { frames: 5 }, { kind: "ring16" }, "impostor"],
  ["cross3", {}, {}, "cross3"],
  ["cross2", {}, {}, "cross2"],
  ["sprite", {}, {}, "sprite"],
  ["real", {}, {}, "real"],
];
for (const [label, bake, mesh, mode] of runs) {
  await page.evaluate(([n, b, m]) => (window as any).lab.prepare(n, b, m), [name, bake, mesh] as const);
  const row: string[] = [];
  for (const count of [10_000, 100_000]) {
    const r = await page.evaluate(([c, md]) => (window as any).lab.perf(c, md), [count, mode] as const);
    row.push(`${count / 1000}k ${Number(r.medianMs).toFixed(2)} ms`);
  }
  console.log(label.padEnd(8), row.join("  "));
}
await browser.close();
await server.close();

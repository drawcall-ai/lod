// Does the GPU time of a split (near instances in one technique, far ones in another)
// equal the sum of its parts timed alone? Same field, same camera; "none" skips a part.
//
//   npx tsx scripts/additivity.ts
//
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const server = await createServer({ root: process.cwd(), logLevel: "error", server: { port: 5196 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);

type Level = { kind: string; minPx: number; buildPx?: number };
const time = async (count: number, levels: Level[]) => {
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) runs.push((await page.evaluate(([c, l]) => (window as any).lab.perfChain(c, l, 0, false, 60), [count, levels] as const)).medianMs);
  return runs.sort((a, b) => a - b)[1]!;
};
const cases: Array<[string, number, string, string, number]> = [
  // subject, instances, near technique, far technique, switch size (px)
  ["oak", 50_000, "real", "octa", 100],
  ["oak", 50_000, "real", "octa", 25],
  ["oak", 50_000, "lod-simple", "octa", 50],
  ["boulder", 5_000, "real", "octa", 100],
  ["boulder", 5_000, "real", "lod-simple", 100],
  ["car", 2_000, "real", "octa", 50],
];
console.log("subject  count   near→far             switch   near alone  far alone   empty   sum-empty   combined   combined/sum");
for (const [subject, count, near, far, px] of cases) {
  await page.evaluate((n) => (window as any).lab.prepare(n), subject);
  const lvl = (kind: string) => (kind === "lod-simple" ? { kind, buildPx: px } : { kind });
  const a = await time(count, [{ ...lvl(near), minPx: px }, { kind: "none", minPx: 0 }]);
  const b = await time(count, [{ kind: "none", minPx: px }, { ...lvl(far), minPx: 0 }]);
  const empty = await time(count, [{ kind: "none", minPx: 0 }]);
  const both = await time(count, [{ ...lvl(near), minPx: px }, { ...lvl(far), minPx: 0 }]);
  const sum = a + b - empty;
  console.log(`${subject.padEnd(8)} ${String(count).padEnd(7)} ${`${near}→${far}`.padEnd(20)} ${String(px).padEnd(8)} ${a.toFixed(2).padStart(9)}  ${b.toFixed(2).padStart(9)}  ${empty.toFixed(2).padStart(6)}  ${sum.toFixed(2).padStart(9)}  ${both.toFixed(2).padStart(9)}   ${(both / sum).toFixed(2)}`);
}
await browser.close();
await server.close();

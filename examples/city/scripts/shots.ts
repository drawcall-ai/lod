// Renders every viewer item at a close and a medium view in headless Chromium on the real
// GPU and saves PNGs to .artifacts/shots/<item>-<view>.png.
//
//   pnpm --filter @drawcall/lod-example-city shots [item,item...] [--query=variant=9] [--out=directory]
//     [--cold] [--browser-profile=<dir>]
//
// --query adds viewer URL parameters; --cold and --browser-profile are in browser.ts.
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { args, flag, open, root } from "./browser.ts";
import type { Viewer } from "../src/viewer/main.ts";
declare const window: { viewer: Viewer };

const out = resolve(root, flag("out") ?? ".artifacts/shots");
await mkdir(out, { recursive: true });
const only = args.find((a) => !a.startsWith("--"))?.split(",");

const session = await open(5191, { width: 1280, height: 800 });
const page = await session.browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && console.error(`[page ${m.type()}]`, m.text()));

try {
  await page.goto(`${session.url}viewer.html?shot&${flag("query") ?? ""}`);
  await page.waitForFunction(() => "viewer" in window, null, { timeout: 120_000 });
  const names = only ?? (await page.evaluate(() => window.viewer.names));
  for (const name of names) {
    const { triangles } = await page.evaluate((n) => window.viewer.show(n), name);
    for (const kind of ["close", "medium"] as const) {
      await page.evaluate((k) => window.viewer.view(k), kind);
      await page.evaluate(() => window.viewer.settle());
      await page.screenshot({ path: join(out, `${name}-${kind}.png`) });
    }
    console.log(`${name.padEnd(24)} ${triangles.toLocaleString().padStart(12)} triangles`);
  }
} finally {
  await session.close();
}
console.log(`shots: ${out}`);

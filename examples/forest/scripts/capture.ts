// Renders fixed views of the forest headless on the GPU, saves PNGs and prints stats
// and GPU frame times. Run: pnpm --filter @drawcall/impostor-example-forest capture
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

type Vec3 = [number, number, number];
interface Api {
  ready: Promise<void>;
  setCamera(position: Vec3, target: Vec3, fov?: number): void;
  setMode(mode: "hybrid" | "impostor" | "real"): void;
  setTint(on: boolean): void;
  screenshot(): string;
  stats(): Record<string, unknown>;
  gpuTime(frames?: number): Promise<{ medianMs: number; p90Ms: number }>;
  height(x: number, z: number): number;
  nearest(name: string, x: number, z: number): { position: Vec3; scale: number; diameter: number };
}
declare const window: { forest: Api };

const root = fileURLToPath(new URL("..", import.meta.url));
const out = fileURLToPath(new URL("../../../.artifacts/forest/", import.meta.url));
await mkdir(out, { recursive: true });
const only = process.argv[2]?.split(",");

const server = await createServer({ root, logLevel: "error", server: { port: 5198, strictPort: false } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.error("[page]", e.message));
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && console.error(`[page ${m.type()}]`, m.text()));

try {
  const started = Date.now();
  await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
  await page.waitForFunction(() => "forest" in window, null, { timeout: 60_000 });
  await page.evaluate(() => window.forest.ready);
  console.log(`ready in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  // Views derived from the scene itself so they stay valid when the scatter changes.
  const views = await page.evaluate(() => {
    const f = window.forest;
    const h = f.height;
    const eye = (x: number, z: number, up: number): Vec3 => [x, h(x, z) + up, z];
    // The camera starts in a clearing at (20, -10). Ground view: look toward the
    // highest ground 400 m out, so the forest climbs a hill behind the clearing's edge.
    const [ox, oz] = [20, -10];
    let best = 0;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 32)
      if (h(ox + Math.cos(a) * 400, oz + Math.sin(a) * 400) > h(ox + Math.cos(best) * 400, oz + Math.sin(best) * 400)) best = a;
    const far = (d: number, up: number) => eye(ox + Math.cos(best) * d, oz + Math.sin(best) * d, up);
    // Close: 9 m from a broadleaf tree, well inside the real range.
    const close = f.nearest("tree", -60, -90);
    const [cx, , cz] = close.position;
    // Hand-off: from the clearing, zoomed onto a pine ~75 m away, inside the band.
    const band = f.nearest("pine", ox + Math.cos(best + 0.6) * 75, oz + Math.sin(best + 0.6) * 75);
    const [bx, , bz] = band.position;
    return {
      ground: { position: far(30, 2), target: far(400, 12), fov: 60 },
      overview: { position: eye(-40, 260, 85), target: eye(-40, 60, 0), fov: 60 },
      close: { position: eye(cx + 7, cz + 6, 2), target: [cx, h(cx, cz) + 4, cz] as Vec3, fov: 60 },
      handoff: { position: eye(ox, oz, 2), target: [bx, h(bx, bz) + 4, bz] as Vec3, fov: 22 },
    };
  });

  for (const [name, view] of Object.entries(views)) {
    if (only && !only.includes(name)) continue;
    const variants: Array<[string, "hybrid" | "impostor" | "real", boolean]> = [["", "hybrid", false]];
    if (name === "handoff" || name === "close") variants.push(["-tint", "hybrid", true]);
    if (name === "ground" || name === "handoff") variants.push(["-impostor", "impostor", false], ["-real", "real", false]);
    for (const [suffix, mode, tint] of variants) {
      const result = await page.evaluate(
        async ([v, mode, tint]) => {
          const f = window.forest;
          f.setMode(mode);
          f.setTint(tint);
          f.setCamera(v.position, v.target, v.fov);
          const image = f.screenshot();
          const time = await f.gpuTime(40);
          return { image, time, stats: f.stats() };
        },
        [view, mode, tint] as const,
      );
      const file = `${out}${name}${suffix}.png`;
      await writeFile(file, Buffer.from(result.image.split(",")[1]!, "base64"));
      const { gpu, bakeMs, perSpecies, ...rest } = result.stats as Record<string, unknown>;
      console.log(
        `${(name + suffix).padEnd(18)} gpu ${result.time.medianMs.toFixed(2)} ms (p90 ${result.time.p90Ms.toFixed(2)})  ${JSON.stringify(rest)}`,
      );
      if (name === "ground" && suffix === "") console.log("  ", gpu, "bake ms", JSON.stringify(bakeMs), JSON.stringify(perSpecies));
    }
  }
  console.log(`saved to ${out}`);
} finally {
  await browser.close();
  await server.close();
}

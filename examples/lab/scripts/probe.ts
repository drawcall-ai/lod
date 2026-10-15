// Impostor probe (see `compare` and `stability` in src/main.ts): coverage ratio, colour
// error and lighting bias of the impostor by on-screen size, for a few subjects and
// ImpostorMesh options; with STABILITY=1 also its flicker against the source's.
//
//   pnpm --filter @drawcall/lod-example-lab probe [subject,subject...] ['[{mesh options}, ...]'] ['{bake options}']
//
import type { BakeImpostorOptions, ImpostorMeshOptions } from "@drawcall/lod";
import { open } from "./lab.ts";

const subjects = (process.argv[2] ?? "tree,pine,dead").split(",");
// Typed by the caller: the JSON is passed to the page as given.
const variants: ImpostorMeshOptions[] = JSON.parse(process.argv[3] ?? "[{}]");
const bake: Omit<BakeImpostorOptions, "renderer"> = JSON.parse(process.argv[4] ?? "{}");

const { page, close } = await open("?auto", "probe");
try {
  for (const name of subjects)
    for (const mesh of variants) {
      await page.evaluate(([n, b, m]) => window.probe.prepare(n, b, m), [name, bake, mesh] as const);
      const row: string[] = [];
      for (const px of [12, 24, 48, 96, 192]) {
        let [coverage, error, bias, k] = [0, 0, 0, 0];
        for (const elevation of [5, 30, 60])
          for (const azimuth of [20, 140, 260]) {
            const r = await page.evaluate((v) => window.probe.compare(v, false), { px, elevation, azimuth });
            coverage += r.coverage;
            error += r.error;
            bias += r.bias;
            k++;
          }
        const flicker = process.env.STABILITY ? await page.evaluate((v) => window.probe.stability(v), { px, elevation: 20, azimuth: 70 }) : null;
        row.push(
          `${px}px cov ${(coverage / k).toFixed(2)} err ${(error / k).toFixed(3)} b ${((bias / k) * 255).toFixed(1)}${flicker ? ` flk ${flicker.ratio.toFixed(2)}` : ""}`,
        );
      }
      console.log(`${name.padEnd(7)} ${JSON.stringify(mesh).padEnd(28)} ${row.join(" | ")}`);
    }
} finally {
  await close();
}

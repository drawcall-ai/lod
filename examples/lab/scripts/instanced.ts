// InstancedLod (see src/instanced.ts): an image compare against one Lod per tree, then
// per count the CPU time of a re-sort and the GPU time of a frame for a grid of trees,
// and the same under a sun with two shadow maps. Writes the compare images to
// .artifacts/instanced; exits non-zero when they differ.
//
//   pnpm --filter @drawcall/lod-example-lab instanced [count,count,...]
//
import { artifacts, open, savePng } from "./lab.ts";

const counts = (process.argv[2] ?? "10000,100000").split(",").map(Number);
const out = await artifacts("instanced");
const { page, close } = await open("instanced.html", "instanced");
let failed = false;
try {
  const c = await page.evaluate(() => window.instanced.compare());
  for (const [name, image] of Object.entries(c.images)) await savePng(out, name, image);
  const ok = c.differing < 0.001;
  failed ||= !ok;
  console.log(
    `${ok ? "ok  " : "FAIL"} instanced vs one Lod per tree: ${(c.differing * 100).toFixed(3)}% pixels differ by > 8, max ${c.max}; per level mesh ${JSON.stringify(c.drawn)}`,
  );

  for (const count of counts) {
    const r = await page.evaluate((n) => window.instanced.perf(n), count);
    console.log(`\n${count} trees on ${r.renderer}`);
    for (const [view, v] of Object.entries(r.results))
      console.log(
        `  ${view.padEnd(7)} update ${v.slowMs.toFixed(2)} ms walking, ${v.fastMs.toFixed(2)} ms flying (CPU); frame ${v.gpuMs.toFixed(2)} ms GPU; per level ${JSON.stringify(v.drawn)}`,
      );
    const s = await page.evaluate((n) => window.instanced.cascades(n), count);
    console.log(
      `  shadows (as many bushes, two maps) frame ${s.gpuMs.toFixed(2)} ms GPU, ${s.triangles} triangles; per level, trees and bushes ${JSON.stringify(s.drawn)}`,
    );
  }
} finally {
  await close();
}
process.exit(failed ? 1 : 0);

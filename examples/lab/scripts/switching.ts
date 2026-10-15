// Lod switching (see src/switching.ts): the visible levels per on-screen height, that
// shadows follow the camera's choice, and that the fade does not pop. Exits non-zero on
// failure.
//
//   pnpm --filter @drawcall/lod-example-lab switching [model.glb,...]
//
import { open } from "./lab.ts";

const models = (process.argv[2] ?? "CommonTree_3.glb,Rock_Medium_1.glb").split(",");

const { page, close } = await open("switching.html", "switching");
let failed = false;
const check = (ok: boolean, line: string) => {
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
};
try {
  for (const model of models) {
    const r = await page.evaluate((m) => window.switching.run(m), model);
    console.log(`\n${model} on ${r.renderer}`);
    for (const l of r.levels)
      check(
        JSON.stringify(l.visible) === JSON.stringify(l.expected) && Math.abs(l.measured / l.pixels - 1) < 1e-4,
        `${String(l.pixels).padStart(4)} px (measured ${l.measured.toFixed(2)}): visible ${JSON.stringify(l.visible)}, expected ${JSON.stringify(l.expected)}`,
      );
    const s = r.shadows;
    check(
      s.autoVsForced === 0 && s.autoVsSource > 0,
      `shadow of level ${JSON.stringify(s.chosen)}: vs forced ${s.autoVsForced.toFixed(4)}, vs source ${s.autoVsSource.toFixed(4)}`,
    );
    const { faded, hard } = r.pop;
    const line = (name: string, p: typeof faded) =>
      `${name}: ${p.steps} steps, worst change ${p.worst.change.toFixed(3)} at ${p.worst.pixels.toFixed(1)} px, ${p.worst.ratio.toFixed(2)}x the steps around it`;
    console.log(`     ${line("swapped at once", hard)}`);
    check(faded.worst.ratio < 3 && faded.worst.ratio < hard.worst.ratio / 2, line("faded", faded));
    console.log(`     1000 new Lods: first frame ${r.firstDraw.firstMs.toFixed(1)} ms, next ${r.firstDraw.nextMs.toFixed(1)} ms (CPU + finish)`);
  }
} finally {
  await close();
}
process.exit(failed ? 1 : 0);

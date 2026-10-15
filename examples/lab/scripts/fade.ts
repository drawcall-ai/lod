// Fade check (see `fade` in src/main.ts): a Lod of source and impostor dithered together
// must cover exactly like the source. Writes the images to .artifacts/fade; exits non-zero
// on failure.
//
//   pnpm --filter @drawcall/lod-example-lab fade [subject,subject...]
//
import { artifacts, open, savePng } from "./lab.ts";

const out = await artifacts("fade");
const { page, close } = await open("?auto", "probe");
let failed = false;
try {
  for (const name of (process.argv[2] ?? "tree,rock,lamp").split(",")) {
    await page.evaluate((n) => window.probe.prepare(n), name);
    for (const amount of [0.2, 0.5, 0.8]) {
      const r = await page.evaluate((a) => window.probe.fade({ px: 128, elevation: 20, azimuth: 60 }, a), amount);
      const ok = Math.abs(r.coverage - 1) < 0.08 && r.drawn.length === 2;
      failed ||= !ok;
      console.log(
        `${name.padEnd(6)} mix ${amount}  levels ${JSON.stringify(r.drawn)}  coverage ${r.coverage.toFixed(3)}  err ${r.error.toFixed(3)} ${ok ? "ok" : "FAIL"}`,
      );
      await savePng(out, `${name}-${amount}`, r.image);
    }
  }
} finally {
  await close();
}
process.exit(failed ? 1 : 0);

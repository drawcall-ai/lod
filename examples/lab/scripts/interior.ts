// Interior mapping (see src/interior.ts): the house's baked level looking into its rooms,
// against the source with its real rooms behind real glass. Writes contact sheets to
// .artifacts/interior and prints, per light and view, the mean colour difference over
// the window pixels (where the rooms show), over the whole image, of the baked level
// under logarithmic vs default depth, and of a Lod dithering between source and baked
// level mid-fade.
//
//   pnpm --filter @drawcall/lod-example-lab interior
//
import { fileURLToPath } from "node:url";
import { artifacts, open, savePng } from "./lab.ts";

const out = await artifacts("interior");
const { page, close } = await open("interior.html", "interior");
try {
  const report = await page.evaluate(() => window.interior.run());
  for (const [name, image] of Object.entries(report.images)) await savePng(out, name, image);
  console.log(`bake ${report.ms} ms`);
  console.log("light view               window px  window err  image err  log vs default  mid-fade err");
  for (const r of report.rows)
    console.log(
      `${r.light.padEnd(5)} ${r.view.padEnd(18)} ${String(r.pixels).padStart(9)} ${String(r.error).padStart(11)} ${String(r.all).padStart(10)} ${String(r.logVsDefault ?? "").padStart(15)} ${String(r.fade ?? "").padStart(13)}`,
    );
  console.log(`images: ${fileURLToPath(out)}`);
} finally {
  await close();
}

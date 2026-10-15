// Loads a generated impostor `.glts` through the real @drawcall/glts loader (see
// src/glts-check.ts), compares it with a directly built ImpostorMesh and writes
// side-by-side images (glts | direct | 8x difference) and result.json to .artifacts/glts.
// Exits non-zero on failure.
//
//   pnpm --filter @drawcall/lod-example-lab glts
//
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { artifacts, open, savePng } from "./lab.ts";

const out = await artifacts("glts");
const { page, close } = await open("glts.html", "gltsCheck");
let pass = false;
try {
  const { result, images } = await page.evaluate(() => window.gltsCheck.run());
  for (const [name, image] of Object.entries(images)) await savePng(out, name, image);
  await writeFile(new URL("result.json", out), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  pass = result.pass;
  const failed = Object.entries(result.checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  console.log(pass ? "PASS" : `FAIL: ${failed.join(", ")}`);
  console.log(`images: ${fileURLToPath(out)}`);
} finally {
  await close();
}
process.exit(pass ? 0 : 1);

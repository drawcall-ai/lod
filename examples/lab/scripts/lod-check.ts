// Mesh levels (see src/lod-check.ts): builds simplified and baked levels, writes contact
// sheets (source | simplified per ratio | baked per ratio [| baked onto an authored low
// mesh], four views), the baked textures and report.json to .artifacts/lod, and prints
// each level's render error against the source over the same views.
//
//   pnpm --filter @drawcall/lod-example-lab lod-check [subject,subject...] [--ratios=0.25,0.05] [--modes=lit,albedo,normal]
//
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Measured, Mode } from "../src/lod-check.ts";
import { artifacts, open, savePng } from "./lab.ts";

const MODES: readonly Mode[] = ["lit", "albedo", "normal"];
const isMode = (value: string): value is Mode => MODES.some((mode) => mode === value);

const args = process.argv.slice(2);
const option = (name: string) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
    .split(",");
const only = args.find((a) => !a.startsWith("--"))?.split(",");
const ratios = option("ratios")?.map(Number);
const modes = option("modes")?.map((mode) => {
  if (!isMode(mode)) throw new Error(`lod-check: unknown mode "${mode}", expected one of ${MODES.join(", ")}`);
  return mode;
});

const out = await artifacts("lod");
const { page, close } = await open("lod.html", "lodCheck");
try {
  const report = await page.evaluate(([o, r, m]) => window.lodCheck.run(o, r, m), [only, ratios, modes] as const);
  for (const [name, image] of Object.entries(report.images)) await savePng(out, name, image);
  await writeFile(new URL("report.json", out), JSON.stringify({ renderer: report.renderer, results: report.results }, null, 2));

  const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)}MB`;
  const row = (name: string, variant: string, r: Measured | { triangles: number; textureBytes: number }, notes = "") => {
    const m = "ms" in r ? r : undefined;
    console.log(
      `${name.padEnd(8)} ${variant.padEnd(16)}${String(r.triangles).padStart(7)} ${String(m?.ms ?? "").padStart(6)} ${mb(r.textureBytes).padStart(7)}  ${String(m?.colorError ?? "").padStart(6)} ${String(m?.coverageError ?? "").padStart(6)}  ${notes}`,
    );
  };
  console.log(report.renderer);
  console.log("subject  level               tris     ms     tex   color  cover  notes");
  for (const r of report.results) {
    row(r.name, "source", r);
    for (const level of r.levels) row("", level.label, level, `error ${level.error?.toFixed(4) ?? "-"}`);
  }
  console.log(`images: ${fileURLToPath(out)}`);
} finally {
  await close();
}

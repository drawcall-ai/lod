// Downloads what public/ (gitignored) draws that git does not hold: the city page's CC0 ground textures from Poly Haven
// and ambientCG as assets/textures/<id>/{diff,nor,arm}.webp and its HDRI as assets/hdri/sky.hdr, with their credits
// in assets/manifest.json, and the files of the Market assets that package.json's assetDependencies name, each into
// public/<name>/. Files already there stay as they are, so edits to an asset's scripts survive.
//
//   pnpm --filter @drawcall/lod-example-city assets
//
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest } from "./assets/manifest.ts";
import { ambientSet, environment, placeSet, textureSet } from "./assets/textures.ts";

/** The texture sets the city page draws. */
const textures = ["Grass001", "aerial_grass_rock", "asphalt_02", "brushed_concrete_04", "cobblestone_floor_04", "farm_soil", "gravel_road"];
/** The sets from ambientCG; the rest are Poly Haven's. Grass001 is a dense green lawn, which Poly Haven lacks. */
const ambientSets = new Set(["Grass001"]);
const hdri = "kloofendal_48d_partly_cloudy_puresky";
const out = fileURLToPath(new URL("../public/", import.meta.url));

const manifest: Manifest = { textures: {}, hdri: await environment(hdri, `${out}assets/`) };
for (const id of textures) {
  manifest.textures[id] = ambientSets.has(id) ? await ambientSet(id) : await textureSet(id);
  await placeSet(id, `${out}assets/`);
}
await writeFile(`${out}assets/manifest.json`, JSON.stringify(manifest, null, 2));

// The Market CLI installs into a project of its own: it would also write the assets' npm ranges over this workspace's.
const { assetDependencies } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { assetDependencies: Record<string, string> };
const project = await mkdtemp(join(tmpdir(), "city-assets-"));
try {
  await writeFile(join(project, "package.json"), JSON.stringify({ private: true }));
  const assets = Object.entries(assetDependencies).map(([name, range]) => `${name}@${range}`);
  execFileSync("npx", ["--yes", "@drawcall/market", "install", ...assets, "--cwd", project], { stdio: "inherit" });
  await cp(join(project, "public"), out, { recursive: true, force: false });
} finally {
  await rm(project, { recursive: true, force: true });
}
console.log(`wrote ${out}: ${textures.length} texture sets, the sky and ${Object.keys(assetDependencies).length} Market assets`);

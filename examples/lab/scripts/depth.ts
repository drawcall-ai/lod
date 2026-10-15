// Every level under three's depth setups in headless Chromium on the real GPU (see
// src/depth.ts): default, reversed (reversedDepthBuffer, float depth target) and
// logarithmic (logarithmicDepthBuffer) depth. Writes the images to .artifacts/depth;
// exits non-zero on failure.
//
// - lit: with near/far where default depth is precise, each mode's lit, shadowed image
//   matches the default's.
// - contact: there, the objects (impostors writing their surface depth) meet the ground
//   at the same pixels in every mode.
// - huge range (near 0.0005, far 20000): against a precise reference (default depth, near
//   0.5, far 2000), reversed and log keep a decal 2 cm above the ground and the objects'
//   contact with it; default depth z-fights (shown, and required, to prove the test sees it).
//
//   pnpm --filter @drawcall/lod-example-lab depth
//
import type { Mode, Shot } from "../src/depth.ts";
import { at } from "../src/must.ts";
import { artifacts, open, savePng } from "./lab.ts";

const out = await artifacts("depth");
let failed = false;
const check = (ok: boolean, line: string) => {
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
};
const percent = (x: number) => `${(x * 100).toFixed(3)}%`;

/** Decoded pixels of `shot`, its PNG saved as `name`. */
async function save(name: string, shot: Shot): Promise<Buffer> {
  await savePng(out, name, shot.image);
  return Buffer.from(shot.pixels, "base64");
}

/** Share of pixels whose largest channel differs by more than 24. */
function differing(a: Buffer, b: Buffer): number {
  let count = 0;
  for (let i = 0; i < a.length; i += 4)
    if (Math.max(Math.abs(at(a, i) - at(b, i)), Math.abs(at(a, i + 1) - at(b, i + 1)), Math.abs(at(a, i + 2) - at(b, i + 2))) > 24) count++;
  return count / (a.length / 4);
}

const DECAL = 2;
const OBJECT = 3;
/** Per pixel: sky (blue), ground (green), decal (red) or object (anything else). */
function classes(pixels: Buffer): Uint8Array {
  const flat = [
    [0, 0, 255],
    [0, 255, 0],
    [255, 0, 0],
  ] as const;
  const out = new Uint8Array(pixels.length / 4);
  for (let p = 0; p < out.length; p++) {
    const found = flat.findIndex(
      ([r, g, b]) => Math.abs(at(pixels, p * 4) - r) + Math.abs(at(pixels, p * 4 + 1) - g) + Math.abs(at(pixels, p * 4 + 2) - b) < 12,
    );
    out[p] = found === -1 ? OBJECT : found;
  }
  return out;
}

/** Of the pixels that are `kind` in `reference`, the share that is not in `c`, and of `c`'s, the share not in `reference`. */
function mismatch(reference: Uint8Array, c: Uint8Array, kind: number): number {
  let lost = 0;
  let gained = 0;
  let total = 0;
  for (let p = 0; p < c.length; p++) {
    if (reference[p] === kind) total++;
    if (reference[p] === kind && c[p] !== kind) lost++;
    if (reference[p] !== kind && c[p] === kind) gained++;
  }
  if (total === 0) throw new Error(`depth: the reference shows no pixel of class ${kind}`);
  return (lost + gained) / total;
}

const { page, close } = await open("depth.html", "depth");
try {
  console.log(`on ${await page.evaluate(() => window.depth.gpu())}\n`);

  const modes: Mode[] = ["reversed", "log"];
  const lit = async (mode: Mode) => save(`lit-${mode}`, await page.evaluate((m) => window.depth.lit(m), mode));
  const masks = async (mode: Mode, near: number, far: number, name: string) =>
    classes(await save(`${name}-${mode}`, await page.evaluate(([m, n, f]) => window.depth.masks(m, n, f), [mode, near, far] as const)));

  const litDefault = await lit("default");
  for (const mode of modes) {
    const d = differing(litDefault, await lit(mode));
    check(d < 0.002, `lit ${mode} vs default (near 0.1, far 1000): ${percent(d)} of pixels differ by > 24`);
  }

  const contactDefault = await masks("default", 0.1, 1000, "contact");
  for (const mode of modes) {
    const c = await masks(mode, 0.1, 1000, "contact");
    const object = mismatch(contactDefault, c, OBJECT);
    check(object < 0.005, `contact ${mode} vs default (near 0.1, far 1000): object pixels mismatch ${percent(object)}`);
  }

  const reference = await masks("default", 0.5, 2000, "huge-reference");
  for (const mode of ["default", "reversed", "log"] as const) {
    const c = await masks(mode, 0.0005, 20000, "huge");
    const decal = mismatch(reference, c, DECAL);
    const object = mismatch(reference, c, OBJECT);
    const line = `huge range ${mode.padEnd(10)}: decal mismatch ${percent(decal).padStart(8)}, object mismatch ${percent(object).padStart(8)} vs precise reference`;
    // Default depth must show the z-fighting the others avoid, or the test proves nothing.
    if (mode === "default") check(decal > 0.05 || object > 0.03, `${line} (z-fights, as expected)`);
    else check(decal < 0.005 && object < 0.005, line);
  }
} finally {
  await close();
}
process.exit(failed ? 1 : 0);

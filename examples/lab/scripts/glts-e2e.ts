// Loads a generated impostor `.glts` through the real @drawcall/glts loader in headless
// Chromium on the real GPU, compares it with a directly built ImpostorMesh and writes
// side-by-side images (glts | direct | 8x difference) to .artifacts/glts.
//
//   npx tsx scripts/glts-e2e.ts
//
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = new URL("../../../.artifacts/glts/", import.meta.url);
await mkdir(out, { recursive: true });

const server = await createServer({ root, logLevel: "error", server: { port: 5198, strictPort: false } });
await server.listen();
const url = server.resolvedUrls!.local[0]!;

const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
let pass = false;
try {
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && console.error("[page]", m.text()));
  page.on("pageerror", (e) => console.error("[page]", e.message));
  await page.goto(`${url}glts.html`);
  await page.waitForFunction(() => "gltsCheck" in window);

  type Check = { run(): Promise<{ result: Record<string, unknown>; images: Record<string, string> }> };
  const { result, images } = await page.evaluate(() => (window as unknown as { gltsCheck: Check }).gltsCheck.run());
  for (const [name, dataUrl] of Object.entries(images))
    await writeFile(new URL(`${name}.png`, out), Buffer.from(dataUrl.split(",")[1]!, "base64"));
  await writeFile(new URL("result.json", out), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  pass = result.pass === true;
  const failed = Object.entries(result.checks as Record<string, boolean>).filter(([, ok]) => !ok).map(([name]) => name);
  console.log(pass ? "PASS" : `FAIL: ${failed.join(", ")}`);
  console.log(`images: ${fileURLToPath(out)}`);
} catch (error) {
  console.error(error);
} finally {
  await browser.close();
  await server.close();
}
process.exit(pass ? 0 : 1);

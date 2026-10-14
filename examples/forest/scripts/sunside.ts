// A tree seen from the sun's side: real vs impostor, with the impostor receiving shadows or not.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const out = new URL("../../../.artifacts/forest-sunside/", import.meta.url);
await mkdir(out, { recursive: true });
const server = await createServer({ root, logLevel: "error", server: { port: 5187 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "forest" in window);
await page.evaluate(() => (window as any).forest.ready);
const shots: Record<string, string> = {};
const setup = await page.evaluate(() => {
  const f = (window as any).forest;
  const t = f.nearest("tree", 60, 40);
  const [x, y, z] = t.position;
  const sun = new f.debug.THREE.Vector3(-0.55, 0.62, -0.56).normalize(); // world.ts SUN_DIRECTION
  const d = 35;
  const eye = [x + sun.x * d, y + 6 + sun.y * d * 0.35, z + sun.z * d];
  f.setCamera(eye, [x, y + 6, z], 35);
  return { tree: t.position, eye };
});
console.log(setup);
for (const [label, mode, receive] of [["real", "real", true], ["impostor-receive", "impostor", true], ["impostor-noreceive", "impostor", false]] as const) {
  shots[label] = await page.evaluate(([m, r]) => {
    const f = (window as any).forest;
    f.setMode(m);
    f.debug.scene.traverse((o: any) => { if (o.isImpostorMesh) o.receiveShadow = r; });
    return f.screenshot();
  }, [mode, receive] as const);
  await writeFile(new URL(`${label}.png`, out), Buffer.from(shots[label]!.split(",")[1]!, "base64"));
}
await browser.close();
await server.close();

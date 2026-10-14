// Use-case x kind matrix: renders every row (a common use case, mostly industry-sourced)
// with every proxy kind, at the distances and angles that use case actually sees, and
// writes blind rating sheets (kinds shuffled, labelled A, B, C...) plus the key.
//
//   npx tsx scripts/matrix.ts [row,row...] [--kinds=a,b] [--set=realistic]
//
// --set=realistic uses the realistic cases (scripts/cases.ts) and writes to .artifacts/matrix-realistic/.
//
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const realisticSet = process.argv.includes("--set=realistic");
const out = new URL(`../../../.artifacts/${realisticSet ? "matrix-realistic" : "matrix"}/`, import.meta.url);
await mkdir(new URL("cells/", out), { recursive: true });

type View = { px: number; elevation: number; azimuth: number; rotation?: [number, number, number]; fov?: number };
interface Row {
  id: string;
  title: string;
  /** switching: judged as the swap from the real object at the hand-off; still: judged on its own */
  mode: "switch" | "still";
  favours: string;
  subjects: string[];
  views: View[];
  /** instances per subject for the GPU column */
  count: number;
}

// Hand-off sizes: ~150 px tall at 1080p is a tree at ~70 m (typical 50–150 m switch).
const ROWS: Row[] = [
  { id: "A", title: "Flyover / descent over a forest", mode: "switch", favours: "octa-hemi", subjects: ["tree", "pine"], count: 50_000,
    views: [{ px: 150, elevation: 55, azimuth: 30 }, { px: 150, elevation: 75, azimuth: 160 }] },
  { id: "B", title: "Tumbling debris / asteroid field", mode: "switch", favours: "octa-full", subjects: ["asteroid", "knot"], count: 5_000,
    views: [{ px: 150, elevation: -40, azimuth: 70, rotation: [40, 20, 110] }, { px: 150, elevation: 20, azimuth: 200, rotation: [160, 0, 30] }] },
  { id: "C", title: "Walking past the forest edge", mode: "switch", favours: "ring", subjects: ["tree", "pine"], count: 20_000,
    views: [{ px: 150, elevation: 4, azimuth: 20 }, { px: 150, elevation: 10, azimuth: 140 }] },
  { id: "D", title: "Ground cover around the player (never switches)", mode: "still", favours: "cross", subjects: ["fern", "bush"], count: 200_000,
    views: [{ px: 420, elevation: 30, azimuth: 30 }, { px: 160, elevation: 20, azimuth: 150 }, { px: 60, elevation: 12, azimuth: 260 }] },
  { id: "E", title: "Background tree line, never approached", mode: "still", favours: "sprite", subjects: ["tree", "pine"], count: 10_000,
    views: [{ px: 36, elevation: 2, azimuth: 40 }, { px: 22, elevation: 4, azimuth: 220 }] },
  { id: "F", title: "Mid-distance trees, third-person camera", mode: "switch", favours: "contested", subjects: ["tree", "pine", "dead"], count: 20_000,
    views: [{ px: 130, elevation: 15, azimuth: 60 }, { px: 130, elevation: 25, azimuth: 240 }] },
  { id: "G", title: "Bushes from an RTS camera", mode: "switch", favours: "contested", subjects: ["bush", "twisted"], count: 50_000,
    views: [{ px: 90, elevation: 55, azimuth: 30 }, { px: 90, elevation: 65, azimuth: 210 }] },
  { id: "H", title: "Rocks and boulders", mode: "switch", favours: "contested", subjects: ["rock"], count: 20_000,
    views: [{ px: 150, elevation: 15, azimuth: 40 }, { px: 150, elevation: 40, azimuth: 250 }] },
  { id: "I", title: "Non-uniform objects (negative control)", mode: "switch", favours: "mesh LOD", subjects: ["wall", "log", "fence"], count: 10_000,
    views: [{ px: 150, elevation: 12, azimuth: 35 }, { px: 150, elevation: 30, azimuth: 115 }] },
];

// The same use cases with assets at game-realistic budgets (scripts/cases.ts): ez-tree
// card trees (~20k tris), Poly Haven scans (2.4k–98k tris), research-sourced cameras.
const REALISTIC: Row[] = [
  { id: "A", title: "Broadleaf forest seen by a walking player", mode: "switch", favours: "octa-hemi", subjects: ["oak", "ash", "quiver"], count: 50_000,
    views: [{ px: 150, elevation: 3, azimuth: 20 }, { px: 150, elevation: 10, azimuth: 140 }] },
  { id: "B", title: "Drone flyover, camera tilting down", mode: "switch", favours: "octa-hemi", subjects: ["oak", "spruce"], count: 50_000,
    views: [{ px: 150, elevation: 55, azimuth: 30 }, { px: 150, elevation: 80, azimuth: 160 }] },
  { id: "C", title: "Conifer ridge on the horizon, never approached", mode: "still", favours: "sprite", subjects: ["spruce", "oak"], count: 100_000,
    views: [{ px: 36, elevation: 3, azimuth: 40 }, { px: 22, elevation: 6, azimuth: 220 }] },
  { id: "D", title: "Boulder field", mode: "switch", favours: "mesh LOD", subjects: ["boulder", "rock07", "cliffstone"], count: 5_000,
    views: [{ px: 150, elevation: 12, azimuth: 40 }, { px: 150, elevation: 40, azimuth: 250 }] },
  { id: "E", title: "Understory around the player (never switches)", mode: "still", favours: "cross", subjects: ["shrub", "rooibos", "fern02"], count: 200_000,
    views: [{ px: 420, elevation: 30, azimuth: 30 }, { px: 160, elevation: 20, azimuth: 150 }, { px: 60, elevation: 12, azimuth: 260 }] },
  { id: "F", title: "Village props seen from an overlook", mode: "switch", favours: "mesh LOD", subjects: ["car", "barrel", "streetlamp"], count: 2_000,
    views: [{ px: 150, elevation: 10, azimuth: 35 }, { px: 150, elevation: 30, azimuth: 115 }] },
  { id: "G", title: "Asteroid belt, tumbling rocks", mode: "switch", favours: "octa-full", subjects: ["moonrock", "boulder"], count: 10_000,
    views: [{ px: 150, elevation: -40, azimuth: 70, rotation: [40, 20, 110] }, { px: 150, elevation: 20, azimuth: 200, rotation: [160, 0, 30] }] },
];

// Columns. Every impostor-family kind shares the 12x12x128 px views (full: 17x17).
const KINDS: Record<string, { bake: object; mesh: object }> = {
  "octa-hemi": { bake: { layout: "hemi", frames: 12 }, mesh: {} },
  "octa-full": { bake: { layout: "full", frames: 17 }, mesh: {} },
  ring: { bake: { layout: "hemi", frames: 5 }, mesh: { kind: "ring16" } },
  cross: { bake: { layout: "hemi", frames: 12 }, mesh: { kind: "cross3" } },
  sprite: { bake: { layout: "hemi", frames: 12 }, mesh: { kind: "sprite" } },
  "lod-simple": { bake: { layout: "hemi", frames: 12 }, mesh: { kind: "lod-simple" } },
  "lod-baked": { bake: { layout: "hemi", frames: 12 }, mesh: { kind: "lod-baked" } },
  // Coarser mesh LODs, as a LOD chain would show further away: 4 and 16 px of error.
  "lod-4px": { bake: { layout: "hemi", frames: 12 }, mesh: { kind: "lod-simple", errorPx: 4 } },
  "lod-16px": { bake: { layout: "hemi", frames: 12 }, mesh: { kind: "lod-simple", errorPx: 16 } },
};

const args = process.argv.slice(2);
const onlyRows = args.find((a) => !a.startsWith("--"))?.split(",");
const onlyKinds = args.find((a) => a.startsWith("--kinds="))?.split("=")[1]?.split(",");
const kinds = Object.keys(KINDS).filter((k) => !onlyKinds || onlyKinds.includes(k));

const server = await createServer({ root, logLevel: "error", server: { port: 5184 } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${server.resolvedUrls!.local[0]}?auto`);
await page.waitForFunction(() => "lab" in window);
// The reference is the real object as an app renders it, not a supersampled ideal.
await page.evaluate(() => (window as any).lab.setTruthScale(1));

const save = (name: string, dataUrl: string) => writeFile(new URL(name, out), Buffer.from(dataUrl.split(",")[1]!, "base64"));
const index: Array<Record<string, unknown>> = [];
const rows = realisticSet ? REALISTIC : ROWS;
for (const row of rows.filter((r) => !onlyRows || onlyRows.includes(r.id))) {
  for (const subject of row.subjects)
    for (const kind of kinds) {
      const { bake, mesh } = KINDS[kind]!;
      // Mesh LODs are picked per view, like a LOD chain: about 1 px of error at that size.
      const perView = kind.startsWith("lod");
      if (!perView)
        await page.evaluate(([n, b, m]) => (window as any).lab.prepare(n, b, m), [subject, bake, mesh] as const);
      for (const [v, view] of row.views.entries()) {
        if (perView)
          await page.evaluate(([n, b, m]) => (window as any).lab.prepare(n, b, m), [subject, bake, { ...mesh, lodError: ((mesh as { errorPx?: number }).errorPx ?? 1) / view.px }] as const);
        const r = await page.evaluate((vv) => (window as any).lab.compare(vv, true), view);
        const file = `cells/${row.id}-${subject}-v${v}-${kind}.png`;
        await save(file, r.image);
        index.push({ row: row.id, subject, view: v, kind, file, error: r.error, iou: r.iou });
      }
      console.log(`${row.id} ${subject.padEnd(8)} ${kind}`);
    }
}
await writeFile(new URL("index.json", out), JSON.stringify({ rows, kinds: Object.keys(KINDS) }, null, 2));
await writeFile(new URL(`metrics-${kinds.join("_")}.json`, out), JSON.stringify(index, null, 2));
await browser.close();
await server.close();
console.log(`cells: ${fileURLToPath(out)}`);

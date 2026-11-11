import { CachedLodLoader, type InstancedLod, type LodGpu, type LodLevel } from "@drawcall/lod";
import seedrandom from "seedrandom";
import { arriving, manager } from "../loading.ts";
import { instancedAt, type Tint } from "./place.ts";
import type { Plan } from "./plan.ts";

/** Each garden thing, by name. */
const THINGS: Record<string, () => Promise<LodLevel[]>> = {
  letterbox: () =>
    new CachedLodLoader(manager, arriving()).loadAsync({
      url: "/letterbox/index.glts",
      levels: [
        { type: "impostor", layout: "hemi", maxPixels: 40, resolution: 64 },
        { type: "empty", maxPixels: 3 },
      ],
    }),
  "patio set": () =>
    new CachedLodLoader(manager, arriving()).loadAsync({
      url: "/patio-set/index.glts",
      levels: [
        { type: "impostor", layout: "hemi", maxPixels: 40, resolution: 64 },
        { type: "empty", maxPixels: 3 },
      ],
    }),
  shed: () =>
    new CachedLodLoader(manager, arriving()).loadAsync({
      url: "/shed/index.glts",
      levels: [
        { type: "impostor", layout: "hemi", maxPixels: 40, resolution: 64 },
        { type: "empty", maxPixels: 3 },
      ],
    }),
  greenhouse: () =>
    new CachedLodLoader(manager, arriving()).loadAsync({
      url: "/greenhouse/index.glts",
      levels: [
        { type: "impostor", layout: "hemi", maxPixels: 40, resolution: 64 },
        { type: "empty", maxPixels: 3 },
      ],
    }),
  "washing line": () =>
    new CachedLodLoader(manager, arriving()).loadAsync({
      url: "/washing-line/index.glts",
      levels: [
        { type: "impostor", layout: "hemi", maxPixels: 40, resolution: 64 },
        { type: "empty", maxPixels: 3 },
      ],
    }),
  swing: () =>
    new CachedLodLoader(manager, arriving()).loadAsync({
      url: "/swing/index.glts",
      levels: [
        { type: "impostor", layout: "hemi", maxPixels: 40, resolution: 64 },
        { type: "empty", maxPixels: 3 },
      ],
    }),
};

/** Hedge designs, which the gardens' hedges take turns with: each keeps its clipped outline through simplified geometry and a distant impostor. */
const HEDGES: (() => Promise<LodLevel[]>)[] = [
  () =>
    new CachedLodLoader(manager, arriving()).loadAsync({
      url: "/hedge/index.glts?length=2&variant=0",
      levels: [
        { type: "simplify", ratio: 0.1, maxPixels: 120 },
        { type: "impostor", layout: "hemi", maxPixels: 30, resolution: 64 },
        { type: "empty", maxPixels: 3 },
      ],
    }),
  () =>
    new CachedLodLoader(manager, arriving()).loadAsync({
      url: "/hedge/index.glts?length=2&variant=1",
      levels: [
        { type: "simplify", ratio: 0.1, maxPixels: 120 },
        { type: "impostor", layout: "hemi", maxPixels: 30, resolution: 64 },
        { type: "empty", maxPixels: 3 },
      ],
    }),
  () =>
    new CachedLodLoader(manager, arriving()).loadAsync({
      url: "/hedge/index.glts?length=2&variant=2",
      levels: [
        { type: "simplify", ratio: 0.1, maxPixels: 120 },
        { type: "impostor", layout: "hemi", maxPixels: 30, resolution: 64 },
        { type: "empty", maxPixels: 3 },
      ],
    }),
];

export async function gardenObjects(plan: Plan, gpu: LodGpu): Promise<InstancedLod[]> {
  return (await Promise.all([gardenThings(plan, gpu), hedges(plan, gpu)])).flat();
}

async function gardenThings(plan: Plan, gpu: LodGpu): Promise<InstancedLod[]> {
  const paints = ["#ffffff", "#9fb0a0", "#b9a58c", "#8c9aa8", "#c9b9a0"];
  return Promise.all(
    [...plan.garden].map(async ([name, spots]) => {
      const load = THINGS[name];
      if (!load) throw new Error(`No garden thing ${name}`);
      const r = seedrandom(String(name.length));
      const paint: Tint = (_, __, color) => {
        const picked = paints[Math.floor(r() * paints.length)];
        if (!picked) throw new Error("no shed paint picked");
        return color.set(picked);
      };
      return instancedAt(gpu, name, await load(), spots, name === "shed" ? paint : undefined);
    }),
  );
}

async function hedges(plan: Plan, gpu: LodGpu): Promise<InstancedLod[]> {
  const variants = await Promise.all(
    HEDGES.map(async (load, variant) => {
      const mine = plan.hedges.filter((_, i) => i % HEDGES.length === variant);
      if (!mine.length) return [];
      const r = seedrandom(String(variant + 7));
      return [instancedAt(gpu, `hedges ${variant}`, await load(), mine, (_, __, color) => color.multiplyScalar(0.85 + 0.25 * r()))];
    }),
  );
  return variants.flat();
}

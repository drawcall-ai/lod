import * as THREE from "three/webgpu";
import { InstancedLod } from "@drawcall/lod";
import { Random } from "../../public/content/random.ts";
import { loader } from "../loading.ts";
import { place } from "./place.ts";
import { HEDGE } from "./gardens.ts";
import type { Plan } from "./plan.ts";

export async function gardenObjects(plan: Plan): Promise<InstancedLod[]> {
  return (await Promise.all([gardenThings(plan), hedges(plan)])).flat();
}

async function gardenThings(plan: Plan): Promise<InstancedLod[]> {
  const paints = ["#ffffff", "#9fb0a0", "#b9a58c", "#8c9aa8", "#c9b9a0"];
  return Promise.all(
    [...plan.garden].map(async ([name, spots]) => {
      const loaded = await loader.loadAsync({
        url: `/props/garden.glts?${new URLSearchParams({ name })}`,
        levels: [
          { type: "impostor", layout: "hemi", maxPixels: 40, resolution: 64 },
          { type: "empty", maxPixels: 3 },
        ],
      });
      const lod = new InstancedLod(loaded, spots.length);
      lod.name = name;
      const r = new Random(name.length);
      const color = new THREE.Color();
      spots.forEach((at, i) => {
        place(lod, i, at);
        if (name === "shed") lod.setColorAt(i, color.set(r.pick(paints)));
      });
      return lod;
    }),
  );
}

/** How many hedge designs share the gardens' hedges. */
const HEDGE_VARIANTS = 3;

/** Hedges keep their clipped outline through simplified geometry and a distant impostor. */
async function hedges(plan: Plan): Promise<InstancedLod[]> {
  return Promise.all(
    Array.from({ length: HEDGE_VARIANTS }, async (_, variant) => {
      const mine = plan.hedges.filter((_, i) => i % HEDGE_VARIANTS === variant);
      const levels = await loader.loadAsync({
        url: `/props/hedge.glts?length=${HEDGE}&variant=${variant}`,
        levels: [
          { type: "simplify", ratio: 0.1, maxPixels: 120 },
          { type: "impostor", layout: "hemi", maxPixels: 30, resolution: 64 },
          { type: "empty", maxPixels: 3 },
        ],
      });
      const lod = new InstancedLod(levels, mine.length);
      lod.name = `hedges ${variant}`;
      const r = new Random(variant + 7);
      const color = new THREE.Color();
      mine.forEach((at, i) => {
        place(lod, i, at);
        lod.setColorAt(i, color.setRGB(1, 1, 1).multiplyScalar(r.range(0.85, 1.1)));
      });
      return lod;
    }),
  );
}

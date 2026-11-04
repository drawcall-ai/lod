import * as THREE from "three/webgpu";
import { InstancedLod } from "@drawcall/lod";
import { gardenLadder, HEDGE_VARIANTS, hedgeLadder } from "../../public/content/ladders.ts";
import { Random } from "../../public/content/random.ts";
import { loader } from "../loading.ts";
import { place } from "./place.ts";
import type { Plan } from "./plan.ts";

export async function gardenObjects(plan: Plan): Promise<InstancedLod[]> {
  return (await Promise.all([gardenThings(plan), hedges(plan)])).flat();
}

async function gardenThings(plan: Plan): Promise<InstancedLod[]> {
  const paints = ["#ffffff", "#9fb0a0", "#b9a58c", "#8c9aa8", "#c9b9a0"];
  return Promise.all(
    [...plan.garden].map(async ([name, spots]) => {
      const loaded = await loader.loadAsync(gardenLadder(name));
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

async function hedges(plan: Plan): Promise<InstancedLod[]> {
  return Promise.all(
    Array.from({ length: HEDGE_VARIANTS }, async (_, variant) => {
      const mine = plan.hedges.filter((_, i) => i % HEDGE_VARIANTS === variant);
      const levels = await loader.loadAsync(hedgeLadder(variant));
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

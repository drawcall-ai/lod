import { InstancedLod } from "@drawcall/lod";
import { gardenLadder, HEDGE_VARIANTS, hedgeLadder } from "../../public/content/ladders.ts";
import { Random } from "../../public/content/random.ts";
import { loader } from "../loading.ts";
import { chunkAt } from "./place.ts";
import type { Plan } from "./plan.ts";

export async function gardenObjects(plan: Plan): Promise<InstancedLod[]> {
  return (await Promise.all([gardenThings(plan), hedges(plan)])).flat();
}

async function gardenThings(plan: Plan): Promise<InstancedLod[]> {
  const paints = ["#ffffff", "#9fb0a0", "#b9a58c", "#8c9aa8", "#c9b9a0"];
  return Promise.all(
    [...plan.garden].map(async ([name, spots]) => {
      const loaded = await loader.loadAsync(gardenLadder(name));
      const lod = new InstancedLod(loaded);
      lod.name = name;
      const r = new Random(name.length);
      lod.addChunk(chunkAt(spots, name === "shed" ? (_, __, color) => color.set(r.pick(paints)) : undefined));
      return lod;
    }),
  );
}

async function hedges(plan: Plan): Promise<InstancedLod[]> {
  return Promise.all(
    Array.from({ length: HEDGE_VARIANTS }, async (_, variant) => {
      const mine = plan.hedges.filter((_, i) => i % HEDGE_VARIANTS === variant);
      const levels = await loader.loadAsync(hedgeLadder(variant));
      const lod = new InstancedLod(levels);
      lod.name = `hedges ${variant}`;
      const r = new Random(variant + 7);
      lod.addChunk(chunkAt(mine, (_, __, color) => color.multiplyScalar(r.range(0.85, 1.1))));
      return lod;
    }),
  );
}

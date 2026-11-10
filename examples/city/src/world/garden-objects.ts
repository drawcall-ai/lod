import type { InstancedLod, LodGpu } from "@drawcall/lod";
import { gardenLadder, HEDGE_VARIANTS, hedgeLadder } from "../../public/content/ladders.ts";
import { Random } from "../../public/content/random.ts";
import { loader } from "../loading.ts";
import { instancedAt } from "./place.ts";
import type { Plan } from "./plan.ts";

export async function gardenObjects(plan: Plan, gpu: LodGpu): Promise<InstancedLod[]> {
  return (await Promise.all([gardenThings(plan, gpu), hedges(plan, gpu)])).flat();
}

async function gardenThings(plan: Plan, gpu: LodGpu): Promise<InstancedLod[]> {
  const paints = ["#ffffff", "#9fb0a0", "#b9a58c", "#8c9aa8", "#c9b9a0"];
  return Promise.all(
    [...plan.garden].map(async ([name, spots]) => {
      const loaded = await loader.loadAsync(gardenLadder(name));
      const r = new Random(name.length);
      return instancedAt(gpu, name, loaded, spots, name === "shed" ? (_, __, color) => color.set(r.pick(paints)) : undefined);
    }),
  );
}

async function hedges(plan: Plan, gpu: LodGpu): Promise<InstancedLod[]> {
  const variants = await Promise.all(
    Array.from({ length: HEDGE_VARIANTS }, async (_, variant) => {
      const mine = plan.hedges.filter((_, i) => i % HEDGE_VARIANTS === variant);
      if (!mine.length) return [];
      const levels = await loader.loadAsync(hedgeLadder(variant));
      const r = new Random(variant + 7);
      return [instancedAt(gpu, `hedges ${variant}`, levels, mine, (_, __, color) => color.multiplyScalar(r.range(0.85, 1.1)))];
    }),
  );
  return variants.flat();
}

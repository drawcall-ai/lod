import { CachedLodLoader, type InstancedLod, type LodGpu, type LodLevel } from "@drawcall/lod";
import seedrandom from "seedrandom";
import { arriving, manager } from "../loading.ts";
import { instancedAt, type Tint } from "./place.ts";
import type { Plan } from "./plan.ts";
import type { Fixture } from "./gardens.ts";

/** Each garden fixture's ladder, by name. */
const FIXTURES: Record<Fixture, () => Promise<LodLevel[]>> = {
  letterbox: () =>
    new CachedLodLoader(manager, arriving()).loadAsync({
      url: "/letterbox/index.glts",
      levels: [
        { type: "impostor", layout: "hemi", maxPixels: 40, resolution: 64 },
        { type: "empty", maxPixels: 3 },
      ],
    }),
  "patio-set": () =>
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
  "washing-line": () =>
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

/** Each garden fixture of the plan over its spots; sheds come in a few paints. */
export async function fixtures(plan: Plan, gpu: LodGpu): Promise<InstancedLod[]> {
  const paints = ["#ffffff", "#9fb0a0", "#b9a58c", "#8c9aa8", "#c9b9a0"];
  return Promise.all(
    [...plan.fixtures].map(async ([name, spots]) => {
      const load = FIXTURES[name];
      const r = seedrandom(name);
      const paint: Tint = (_, __, color) => {
        const picked = paints[Math.floor(r() * paints.length)];
        if (!picked) throw new Error("no shed paint picked");
        return color.set(picked);
      };
      return instancedAt(gpu, name, await load(), spots, name === "shed" ? paint : undefined);
    }),
  );
}

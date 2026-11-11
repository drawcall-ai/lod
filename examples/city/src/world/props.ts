import * as THREE from "three/webgpu";
import { CachedLodLoader, type InstancedLod, type LodGpu, type LodLevel } from "@drawcall/lod";
import { arriving, manager } from "../loading.ts";
import seedrandom from "seedrandom";
import { instancedAt, spread } from "./place.ts";
import type { Plan } from "./plan.ts";
import { fixtures } from "./fixtures.ts";
import type { SignName } from "./town.ts";

const shadows = arriving((object) => object.traverse((node) => (node.castShadow = node.receiveShadow = true)));

/**
 * Street furniture and cars, by model: they keep their meshes nearby and use a small impostor in the distance, whose
 * self-contained textures let the overview defer original model fetches. Below a few pixels (more for thin lamps,
 * which vanish into a line sooner) they disappear.
 */
const MODELS: Record<string, () => Promise<LodLevel[]>> = {
  street_lamp_01: () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/assets/models/street_lamp_01/street_lamp_01.glb",
      levels: [
        { type: "simplify", ratio: 0.03 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 60 },
        { type: "empty", maxPixels: 8 },
      ],
    }),
  painted_wooden_bench: () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/assets/models/painted_wooden_bench/painted_wooden_bench.glb",
      levels: [
        { type: "simplify", ratio: 0.5 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 60 },
        { type: "empty", maxPixels: 3 },
      ],
    }),
  metal_trash_can: () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/assets/models/metal_trash_can/metal_trash_can.glb",
      levels: [
        { type: "simplify", ratio: 0.25 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 60 },
        { type: "empty", maxPixels: 3 },
      ],
    }),
  fire_hydrant: () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/assets/models/fire_hydrant/fire_hydrant.glb",
      levels: [
        { type: "simplify", ratio: 0.1 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 60 },
        { type: "empty", maxPixels: 3 },
      ],
    }),
  utility_box_01: () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/assets/models/utility_box_01/utility_box_01.glb",
      levels: [
        { type: "simplify", ratio: 0.5 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 60 },
        { type: "empty", maxPixels: 3 },
      ],
    }),
  covered_car: () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/assets/models/covered_car/covered_car.glb",
      levels: [
        { type: "simplify", ratio: 0.12 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 60 },
        { type: "empty", maxPixels: 4 },
      ],
    }),
  wooden_crate_01: () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/assets/models/wooden_crate_01/wooden_crate_01.glb",
      levels: [
        { type: "simplify", ratio: 0.5 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 60 },
        { type: "empty", maxPixels: 3 },
      ],
    }),
  planter_box_01: () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/assets/models/planter_box_01/planter_box_01.glb",
      levels: [
        { type: "simplify", ratio: 0.5 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 60 },
        { type: "empty", maxPixels: 3 },
      ],
    }),
};

const fence = () =>
  new CachedLodLoader(manager, arriving()).loadAsync({
    url: "/fence/index.glts?length=2.4",
    levels: [
      { type: "simplify", ratio: 0.3 },
      { type: "impostor", layout: "hemi", maxPixels: 40, resolution: 64 },
      { type: "empty", maxPixels: 10 },
    ],
  });

/** A street sign per name, which its query paints on. */
const SIGNS: Record<SignName, () => Promise<LodLevel[]>> = {
  "Maple St": () =>
    new CachedLodLoader(manager, arriving()).loadAsync({
      url: "/street-sign/index.glts?text=Maple+St",
      levels: [
        { type: "simplify", ratio: 0.5 },
        { type: "impostor", layout: "hemi", maxPixels: 20, resolution: 64 },
        { type: "empty", maxPixels: 4 },
      ],
    }),
  "Church Rd": () =>
    new CachedLodLoader(manager, arriving()).loadAsync({
      url: "/street-sign/index.glts?text=Church+Rd",
      levels: [
        { type: "simplify", ratio: 0.5 },
        { type: "impostor", layout: "hemi", maxPixels: 20, resolution: 64 },
        { type: "empty", maxPixels: 4 },
      ],
    }),
  "Mill Lane": () =>
    new CachedLodLoader(manager, arriving()).loadAsync({
      url: "/street-sign/index.glts?text=Mill+Lane",
      levels: [
        { type: "simplify", ratio: 0.5 },
        { type: "impostor", layout: "hemi", maxPixels: 20, resolution: 64 },
        { type: "empty", maxPixels: 4 },
      ],
    }),
  "Oak Ave": () =>
    new CachedLodLoader(manager, arriving()).loadAsync({
      url: "/street-sign/index.glts?text=Oak+Ave",
      levels: [
        { type: "simplify", ratio: 0.5 },
        { type: "impostor", layout: "hemi", maxPixels: 20, resolution: 64 },
        { type: "empty", maxPixels: 4 },
      ],
    }),
  "High St": () =>
    new CachedLodLoader(manager, arriving()).loadAsync({
      url: "/street-sign/index.glts?text=High+St",
      levels: [
        { type: "simplify", ratio: 0.5 },
        { type: "impostor", layout: "hemi", maxPixels: 20, resolution: 64 },
        { type: "empty", maxPixels: 4 },
      ],
    }),
  "Elm St": () =>
    new CachedLodLoader(manager, arriving()).loadAsync({
      url: "/street-sign/index.glts?text=Elm+St",
      levels: [
        { type: "simplify", ratio: 0.5 },
        { type: "impostor", layout: "hemi", maxPixels: 20, resolution: 64 },
        { type: "empty", maxPixels: 4 },
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

export async function props(plan: Plan, gpu: LodGpu): Promise<THREE.Group> {
  const root = new THREE.Group();
  root.name = "props";
  const pending = Object.entries(MODELS).map(async ([id, load]) => {
    const spots = plan.models.get(id);
    if (!spots?.length) return [];
    return spread(gpu, id, [await load()], spots);
  });
  if (plan.fences.length) pending.push(fence().then((levels) => spread(gpu, "fence", [levels], plan.fences)));
  for (const [name, spots] of plan.signs) pending.push(SIGNS[name]().then((levels) => spread(gpu, `sign ${name}`, [levels], spots)));
  pending.push(fixtures(plan, gpu), hedges(plan, gpu));
  root.add(...(await Promise.all(pending)).flat());
  return root;
}

/** The plan's hedge sections, the designs taking turns, each section a little lighter or darker. */
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

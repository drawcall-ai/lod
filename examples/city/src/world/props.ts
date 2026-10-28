import * as THREE from "three/webgpu";
import { Lod, LodLoader, type LevelRequest } from "@drawcall/lod";
import { picketFence } from "../content/fence.ts";
import { streetSign } from "../content/sign.ts";
import { step } from "../loading.ts";
import { variants } from "../content/models.ts";
import { spread } from "./place.ts";
import type { Plan } from "./plan.ts";
import { model, proceduralFiles } from "./cache.ts";
import { gardenObjects } from "./garden-objects.ts";
import { object } from "./objects.ts";
import { propMeshes } from "./prop-meshes.ts";

/**
 * Street furniture, cars and fences: hard surfaces, so a simplified copy (keeping half or
 * a quarter of the triangles, as thin parts tear beyond that) and no impostor, which
 * would cost more than the mesh. Below a few pixels (more for thin lamps and fences, which
 * vanish into a line long before) they are not drawn at all; from above the town they are
 * specks. The empty far level also lets the overview defer every original model fetch.
 */
const PROPS: { id: string; groups: string[][]; ratio: number; cull: number }[] = [
  { id: "street_lamp_01", groups: [["street_lamp_01"]], ratio: 0.03, cull: 8 },
  { id: "painted_wooden_bench", groups: [["painted_wooden_bench"]], ratio: 0.5, cull: 3 },
  {
    id: "metal_trash_can",
    groups: [["metal_trash_can", "metal_trash_can_lid", "metal_trash_can_handle_left", "metal_trash_can_handle_right"]],
    ratio: 0.25,
    cull: 3,
  },
  {
    id: "fire_hydrant",
    groups: [["fire_hydrant", "fire_hydrant_cap_01", "fire_hydrant_cap_02", "fire_hydrant_cap_03", "fire_hydrant_chain"]],
    ratio: 0.1,
    cull: 3,
  },
  { id: "utility_box_01", groups: [["utility_box_01_box"]], ratio: 0.5, cull: 3 },
  {
    id: "covered_car",
    groups: [["covered_car", "covered_car_wheel_01", "covered_car_wheel_02", "covered_car_wheel_03", "covered_car_wheel_04"]],
    ratio: 0.12,
    cull: 4,
  },
  { id: "wooden_crate_01", groups: [["wooden_crate_01", "wooden_crate_01_lid", "wooden_crate_01_latch"]], ratio: 0.5, cull: 3 },
  { id: "planter_box_01", groups: [["planter_box_01"]], ratio: 0.5, cull: 3 },
];

const loader = new LodLoader();

export async function props(plan: Plan): Promise<THREE.Group> {
  const root = new THREE.Group();
  root.name = "props";
  const pending = PROPS.map(async ({ id, groups, ratio, cull }) => {
    const spots = plan.models.get(id);
    if (!spots?.length) return [];
    const models = await step(id, () =>
      Promise.all(
        variants(id, groups).map(async (source, index) => {
          const levels: LevelRequest[] = [{ type: "mesh", ratio }];
          levels.push({ type: "empty", maxPixels: cull });
          const loaded = await loader.loadLevelsAsync({
            source: async () => propMeshes(await source()),
            reference: true,
            key: {
              ...model(id, index, groups),
              props: { path: "src/world/props.ts" },
              batching: { path: "src/world/prop-meshes.ts" },
            },
            levels,
          });
          return new Lod(loaded);
        }),
      ),
    );
    return spread(id, models, spots);
  });
  if (plan.fences.length) {
    pending.push(
      step("fence", () => object(proceduralFiles("src/content/fence.ts", { length: 2.4 }, ["wood_table_001"]), () => picketFence(2.4), 10, 0.3)).then((model) =>
        spread("fence", [model], plan.fences),
      ),
    );
  }
  for (const [name, spots] of plan.signs) {
    pending.push(
      step(`sign ${name}`, () => object(proceduralFiles("src/content/sign.ts", { text: name }, ["metal_plate_02"]), () => streetSign(name), 4, 0.5)).then(
        (model) => spread(`sign ${name}`, [model], spots),
      ),
    );
  }
  pending.push(gardenObjects(plan));
  root.add(...(await Promise.all(pending)).flat());
  return root;
}

import type * as THREE from "three";
import type { InstancedLod } from "@drawcall/lod";
import { picketFence } from "../content/fence.ts";
import { streetSign } from "../content/sign.ts";
import { step } from "../loading.ts";
import { variants } from "../content/models.ts";
import { culled, instanced, place, simplified, spread, type Level } from "./levels.ts";
import type { Plan } from "./plan.ts";

/**
 * Street furniture, cars and fences: hard surfaces, so a simplified copy (keeping half or
 * a quarter of the triangles, as thin parts tear beyond that) and no impostor, which
 * would cost more than the mesh. Below a few pixels (more for thin lamps and fences, which
 * vanish into a line long before) they are not drawn at all; from above the town they are
 * specks. The bench is low-poly already: source only.
 */
const PROPS: { id: string; groups: string[][]; ratio: number | null; cull: number }[] = [
  { id: "street_lamp_01", groups: [["street_lamp_01"]], ratio: 0.03, cull: 8 },
  { id: "painted_wooden_bench", groups: [["painted_wooden_bench"]], ratio: null, cull: 3 },
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

export async function props(plan: Plan): Promise<InstancedLod[]> {
  const lods: InstancedLod[] = [];
  for (const { id, groups, ratio, cull } of PROPS) {
    const spots = plan.models.get(id) ?? [];
    if (spots.length === 0) continue;
    const sources = await variants(id, groups);
    lods.push(...(await step(id, () => spread(id, sources, spots, (source) => levels(source, ratio, cull)))));
  }
  const fence = await step("fence", async () => instanced("fence", picketFence(2.4), await levels(picketFence(2.4), 0.3, 10), plan.fences.length));
  plan.fences.forEach((at, i) => place(fence, i, at));
  lods.push(fence);
  for (const [name, spots] of plan.signs) {
    const source = streetSign(name);
    const sign = await step(`sign ${name}`, async () => instanced(`sign ${name}`, source, await levels(source, 0.5, 4), spots.length));
    spots.forEach((at, i) => place(sign, i, at));
    lods.push(sign);
  }
  return lods;
}

async function levels(source: THREE.Object3D, ratio: number | null, cull: number): Promise<Level[]> {
  return ratio === null ? [culled(cull)] : [await simplified(source, ratio), culled(cull)];
}

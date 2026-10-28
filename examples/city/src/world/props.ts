import * as THREE from "three/webgpu";
import { Lod, type InstancedLod } from "@drawcall/lod";
import { picketFence } from "../content/fence.ts";
import { streetSign } from "../content/sign.ts";
import { downloaded, step } from "../loading.ts";
import { variants } from "../content/models.ts";
import { culled, instanced, place, simplified, spread, type Level } from "./levels.ts";
import type { Plan, Spot } from "./plan.ts";
import { modelBounds } from "./model-bounds.ts";
import { bundle, file, proceduralFiles } from "./cache.ts";
import { Stream, needed } from "./stream.ts";
import { Patches } from "./patches.ts";
import { gardenObjects } from "./garden-objects.ts";

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

export async function props(plan: Plan): Promise<Stream> {
  let fence: THREE.Group | undefined;
  const signs = new Map<string, THREE.Group>();
  const fenceSource = () => (fence ??= picketFence(2.4));
  const signSource = (name: string) => {
    let source = signs.get(name);
    if (!source) signs.set(name, (source = streetSign(name)));
    return source;
  };
  let gardens: InstancedLod[] | undefined;
  const gardenRoots = () => (gardens ??= gardenObjects(plan));
  const files = await bundle(
    "prop-shapes@2",
    {
      ...proceduralFiles("src/world/props.ts", { garden: [...plan.garden.keys()] }, ["wood_table_001", "metal_plate_02"]),
      gardens: { path: "src/world/gardens.ts" },
      objects: { path: "src/world/garden-objects.ts" },
    },
    async () => {
      const sources = gardenRoots().map((lod) => {
        const source = lod.levels[0]?.object;
        if (!source) throw new Error(`${lod.name}: missing garden source`);
        return source;
      });
      const bounds = [fenceSource(), signSource(plan.signs.keys().next().value ?? ""), ...sources].map((source) => {
        const box = new THREE.Box3().setFromObject(source);
        return [...box.min.toArray(), ...box.max.toArray()];
      });
      return { bounds: new TextEncoder().encode(JSON.stringify(bounds)) };
    },
  );
  const value: unknown = JSON.parse(new TextDecoder().decode(file(files, "bounds")));
  if (!Array.isArray(value) || value.length !== 2 + plan.garden.size + 3) throw new Error("Invalid cached prop bounds");
  const boxes = value.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== 6 || !row.every((x) => typeof x === "number" && Number.isFinite(x))) throw new Error("Invalid cached prop box");
    return new THREE.Box3().setFromArray(row.map((x) => Number(x)));
  });
  const spheres: { centre: THREE.Vector3; radius: number; pixels: number }[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const add = (box: THREE.Box3, spots: Spot[], cull: number) => {
    const local = box.getBoundingSphere(new THREE.Sphere());
    for (const spot of spots) {
      const centre = local.center
        .clone()
        .multiplyScalar(spot.scale)
        .applyAxisAngle(up, spot.angle)
        .add(new THREE.Vector3(spot.x, spot.y, spot.z));
      spheres.push({ centre, radius: local.radius * spot.scale, pixels: cull * (1 - Lod.fade) });
    }
  };
  for (const { id, cull } of PROPS) {
    add(modelBounds(id), plan.models.get(id) ?? [], cull);
  }
  const [fenceBox, signBox] = boxes;
  if (!fenceBox || !signBox) throw new Error("Missing procedural prop bounds");
  add(fenceBox, plan.fences, 10);
  for (const spots of plan.signs.values()) add(signBox, spots, 4);
  let gardenIndex = 2;
  for (const spots of plan.garden.values()) {
    const box = boxes[gardenIndex++];
    if (!box) throw new Error("Missing cached garden bounds");
    add(box, spots, 3);
  }
  const hedges = boxes.slice(gardenIndex);
  hedges.forEach((box, design) =>
    add(
      box,
      plan.hedges.filter((_, i) => i % hedges.length === design),
      3,
    ),
  );
  return new Stream(
    "props",
    [],
    async () => {
      const props = await buildProps(plan, fenceSource, signSource);
      const roots = [...props, ...gardenRoots()];
      await downloaded();
      return roots;
    },
    (camera) => spheres.some(({ centre, radius, pixels }) => needed(camera, centre, radius, pixels, Patches.height * Lod.quality)),
  );
}

async function buildProps(plan: Plan, fenceSource: () => THREE.Group, signSource: (name: string) => THREE.Group): Promise<InstancedLod[]> {
  const lods: InstancedLod[] = [];
  for (const { id, groups, ratio, cull } of PROPS) {
    const spots = plan.models.get(id) ?? [];
    if (spots.length === 0) continue;
    const sources = await variants(id, groups);
    lods.push(...(await step(id, () => spread(id, sources, spots, (source) => levels(source, ratio, cull)))));
  }
  const source = fenceSource();
  const fence = await step("fence", async () => instanced("fence", source, await levels(source, 0.3, 10), plan.fences.length));
  plan.fences.forEach((at, i) => place(fence, i, at));
  lods.push(fence);
  for (const [name, spots] of plan.signs) {
    const source = signSource(name);
    const sign = await step(`sign ${name}`, async () => instanced(`sign ${name}`, source, await levels(source, 0.5, 4), spots.length));
    spots.forEach((at, i) => place(sign, i, at));
    lods.push(sign);
  }
  return lods;
}

async function levels(source: THREE.Object3D, ratio: number | null, cull: number): Promise<Level[]> {
  return ratio === null ? [culled(cull)] : [await simplified(source, ratio), culled(cull)];
}

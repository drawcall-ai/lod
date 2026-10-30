import * as THREE from "three/webgpu";
import { loader } from "../loading.ts";
import { spread } from "./place.ts";
import type { Plan } from "./plan.ts";
import { gardenObjects } from "./garden-objects.ts";

/**
 * Street furniture and cars keep their meshes nearby and use a small impostor in the
 * distance. Its self-contained textures let the overview defer original model fetches.
 * Below a few pixels (more for thin lamps, which vanish into a line sooner) they disappear.
 */
const PROPS = [
  { id: "street_lamp_01", ratio: 0.03, cull: 8 },
  { id: "painted_wooden_bench", ratio: 0.5, cull: 3 },
  { id: "metal_trash_can", ratio: 0.25, cull: 3 },
  { id: "fire_hydrant", ratio: 0.1, cull: 3 },
  { id: "utility_box_01", ratio: 0.5, cull: 3 },
  { id: "covered_car", ratio: 0.12, cull: 4 },
  { id: "wooden_crate_01", ratio: 0.5, cull: 3 },
  { id: "planter_box_01", ratio: 0.5, cull: 3 },
];

export async function props(plan: Plan): Promise<THREE.Group> {
  const root = new THREE.Group();
  root.name = "props";
  const pending = PROPS.map(async ({ id, ratio, cull }) => {
    const spots = plan.models.get(id);
    if (!spots?.length) return [];
    const levels = await loader.loadAsync({
      url: `/assets/models/${id}/${id}.glb`,
      levels: [
        { type: "simplify", ratio },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 60 },
        { type: "empty", maxPixels: cull },
      ],
      onLevel: (object) => object.traverse((node) => (node.castShadow = node.receiveShadow = true)),
    });
    return spread(id, [levels], spots);
  });
  if (plan.fences.length)
    pending.push(
      (async () => {
        const levels = await loader.loadAsync({
          url: "/props/fence.glts?length=2.4",
          levels: [
            { type: "simplify", ratio: 0.3 },
            { type: "impostor", layout: "hemi", maxPixels: 40, resolution: 64 },
            { type: "empty", maxPixels: 10 },
          ],
        });
        return spread("fence", [levels], plan.fences);
      })(),
    );
  for (const [name, spots] of plan.signs)
    pending.push(
      (async () => {
        const levels = await loader.loadAsync({
          url: `/props/sign.glts?${new URLSearchParams({ text: name })}`,
          levels: [
            { type: "simplify", ratio: 0.5 },
            { type: "impostor", layout: "hemi", maxPixels: 20, resolution: 64 },
            { type: "empty", maxPixels: 4 },
          ],
        });
        return spread(`sign ${name}`, [levels], spots);
      })(),
    );
  pending.push(gardenObjects(plan));
  root.add(...(await Promise.all(pending)).flat());
  return root;
}

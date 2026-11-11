import * as THREE from "three/webgpu";
import { loader } from "../loading.ts";
import { FENCE, PROPS, propLadder, signLadder } from "../../public/content/ladders.ts";
import type { LodPool } from "@drawcall/lod";
import { spread } from "./place.ts";
import type { Plan } from "./plan.ts";
import { gardenObjects } from "./garden-objects.ts";

export async function props(plan: Plan, pool: LodPool): Promise<THREE.Group> {
  const root = new THREE.Group();
  root.name = "props";
  const pending = PROPS.map(async (prop) => {
    const spots = plan.models.get(prop.id);
    if (!spots?.length) return [];
    const levels = await loader.loadAsync({
      ...propLadder(prop),
      onLevel: (object) => object.traverse((node) => (node.castShadow = node.receiveShadow = true)),
    });
    return spread(pool, prop.id, [levels], spots);
  });
  if (plan.fences.length)
    pending.push(
      (async () => {
        const levels = await loader.loadAsync(FENCE);
        return spread(pool, "fence", [levels], plan.fences);
      })(),
    );
  for (const [name, spots] of plan.signs)
    pending.push(
      (async () => {
        const levels = await loader.loadAsync(signLadder(name));
        return spread(pool, `sign ${name}`, [levels], spots);
      })(),
    );
  pending.push(gardenObjects(plan, pool));
  root.add(...(await Promise.all(pending)).flat());
  return root;
}

import { Lod, type LodGpu, type LodRequest } from "@drawcall/lod";
import * as THREE from "three/webgpu";
import { HOUSE_VARIANTS } from "../../public/content/house/params.ts";
import { CHURCH, houseLadder, type Ladder } from "../../public/content/ladders.ts";
import { Random } from "../../public/content/random.ts";
import { loader } from "../loading.ts";
import { instancedAt } from "./place.ts";
import type { Plan } from "./plan.ts";

const WARMER = new THREE.Color(1.05, 0.98, 0.88);

export async function houses(plan: Plan, gpu: LodGpu): Promise<THREE.Group> {
  const root = new THREE.Group();
  root.name = "houses";
  const homes = Array.from({ length: HOUSE_VARIANTS }, async (_, variant) => {
    const spots = plan.houses.filter((house) => house.variant === variant).map((house) => house.spot);
    if (!spots.length) return [];
    const levels = await loader.loadAsync(request(houseLadder(variant)));
    return [
      instancedAt(gpu, `house ${variant}`, levels, spots, (_, index, color) => {
        const random = new Random(index * 31 + variant);
        return color.multiplyScalar(random.range(0.88, 1.04)).lerp(WARMER, random.range(0, 0.4));
      }),
    ];
  });
  const [variants, levels] = await Promise.all([Promise.all(homes), loader.loadAsync(request(CHURCH))]);
  const building = new Lod(levels, gpu);
  building.name = "church";
  building.position.set(plan.church.x, plan.church.y, plan.church.z);
  building.rotation.y = plan.church.angle;
  root.add(...variants.flat(), building);
  return root;
}

/** Derived levels cast and receive shadows. */
function request(ladder: Ladder): LodRequest {
  return {
    ...ladder,
    onLevel: (object, index) => {
      if (index > 0) object.castShadow = object.receiveShadow = true;
    },
  };
}

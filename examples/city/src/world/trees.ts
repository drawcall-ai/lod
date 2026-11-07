import type { Wind } from "@drawcall/lod";
import * as THREE from "three/webgpu";
import { Random } from "../../public/content/random.ts";
import { loader } from "../loading.ts";
import { foliageLevels, foliageModel, MODEL_FOLIAGE } from "../../public/content/foliage.ts";
import { SPECIES, treeLadder } from "../../public/content/ladders.ts";
import { spread } from "./place.ts";
import { sourceBox } from "./bounds.ts";
import type { Plan } from "./plan.ts";

export async function trees(plan: Plan, wind?: Wind): Promise<THREE.Group> {
  const root = new THREE.Group();
  root.name = "trees";
  const loaded = await Promise.all(
    SPECIES.map(async (species) => {
      const spots = plan.models.get(species.id);
      if (!spots?.length) return [];
      const models = await Promise.all(
        species.variants.map(async (variant) => {
          return loader.loadAsync({
            ...treeLadder(species, variant),
            onLevel: (object) => {
              object.traverse((node) => (node.castShadow = node.receiveShadow = true));
              foliageModel(object, MODEL_FOLIAGE);
              foliageLevels(object, MODEL_FOLIAGE);
            },
          });
        }),
      );
      const crowds = spread(species.id, models, spots, foliageTint);
      for (const crowd of crowds) {
        const box = sourceBox(crowd.levels);
        // A soft shadow under the crown where the trunk meets the ground.
        crowd.contact = { radius: Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.4, strength: 0.55, distance: 80 };
        if (wind) wind.apply(crowd, { amplitude: (box.max.y - box.min.y) * 0.025 });
      }
      return crowds;
    }),
  );
  root.add(...loaded.flat());
  return root;
}

/** Every tree a little different: lighter or darker, yellower or bluer green. */
function foliageTint(seed: number, color: THREE.Color): THREE.Color {
  const r = new Random(seed);
  return color
    .setRGB(1, 1, 1)
    .multiplyScalar(r.range(0.82, 1.1))
    .lerp(r.chance(0.5) ? YELLOWER : BLUER, r.range(0, 0.35));
}

const YELLOWER = new THREE.Color(1.1, 1.05, 0.7);
const BLUER = new THREE.Color(0.85, 0.95, 1.0);

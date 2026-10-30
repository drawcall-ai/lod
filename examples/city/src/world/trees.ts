import { type LevelRequest, type Wind } from "@drawcall/lod";
import * as THREE from "three/webgpu";
import { Random } from "../../public/content/random.ts";
import { loader } from "../loading.ts";
import { foliageLevels, foliageModel, MODEL_FOLIAGE } from "../../public/content/foliage.ts";
import { spread } from "./place.ts";
import { sourceBox } from "./bounds.ts";
import type { Plan } from "./plan.ts";

interface Species {
  id: string;
  variants: string[];
  maxPixels: number;
  resolution?: number;
  frames?: number;
  cull?: number;
}

/**
 * Trees and shrubs (Poly Haven scans, every leaf a card): per species and variant one
 * InstancedLod whose ladder is the source model, a detailed hemispherical impostor (they
 * always stand upright) from the species' maxPixels, a 64 px impostor from 60 px, then,
 * for small plants, an empty level that culls them below `cull` px. No simplified level:
 * decimated leaf cards look ragged, while the impostor keeps every leaf's look. The
 * switch heights are set for the frame budget; the broadleaf scan keeps its full leaf
 * geometry nearby and a larger impostor.
 */
const SPECIES: Species[] = [
  { id: "tree_small_02", variants: ["tree_small_02_LOD0"], maxPixels: 900, resolution: 256, frames: 10 },
  { id: "searsia_lucida", variants: ["searsia_lucida_a_LOD0", "searsia_lucida_e_LOD0"], maxPixels: 300 },
  { id: "pine_sapling_small", variants: ["pine_sapling_small_a", "pine_sapling_small_b"], maxPixels: 300 },
  { id: "shrub_02", variants: ["shrub_02_a", "shrub_02_c"], maxPixels: 300, cull: 2 },
  // garden perennials and vegetables
  { id: "fern_02", variants: ["fern_02_a", "fern_02_b"], maxPixels: 200, cull: 2 },
  { id: "nettle_plant", variants: ["nettle_plant_medium_a_LOD0", "nettle_plant_tall_a_LOD0"], maxPixels: 200, cull: 2 },
];

export async function trees(plan: Plan, wind?: Wind): Promise<THREE.Group> {
  const root = new THREE.Group();
  root.name = "trees";
  const loaded = await Promise.all(
    SPECIES.map(async (species) => {
      const { id, variants, maxPixels, resolution, frames, cull } = species;
      const spots = plan.models.get(id);
      if (!spots?.length) return [];
      const models = await Promise.all(
        variants.map(async (variant) => {
          const levels: LevelRequest[] = [
            { type: "impostor", layout: "hemi", maxPixels, resolution, frames },
            { type: "impostor", layout: "hemi", maxPixels: 60, resolution: 64, frames: 8 },
          ];
          if (cull !== undefined) levels.push({ type: "empty", maxPixels: cull });
          return loader.loadAsync({
            url: `/assets/models/${id}/${variant}.glb`,
            levels,
            onLevel: (object) => {
              object.traverse((node) => (node.castShadow = node.receiveShadow = true));
              foliageModel(object, MODEL_FOLIAGE);
              foliageLevels(object, MODEL_FOLIAGE);
            },
          });
        }),
      );
      const crowds = spread(id, models, spots, foliageTint);
      if (wind)
        for (const crowd of crowds) {
          const box = sourceBox(crowd.levels);
          const height = box.max.y - box.min.y;
          wind.apply(crowd, { amplitude: height * 0.025 });
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

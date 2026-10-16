import { type InstancedLod, simplify } from "@drawcall/lod";
import * as THREE from "three";
import { Random } from "../content/random.ts";
import { step } from "../loading.ts";
import { foliageLevels } from "../content/foliage.ts";
import { MODEL_FOLIAGE, variants } from "../content/models.ts";
import { culled, impostor, spread } from "./levels.ts";
import type { Plan } from "./plan.ts";

/**
 * Trees and shrubs (Poly Haven scans, every leaf a card): per species and variant one
 * InstancedLod of the model, then a hemispherical impostor (they always stand upright)
 * out to the horizon. No simplified level between: decimated leaf cards look ragged,
 * while the impostor keeps every leaf's look. The switch heights are set for the frame
 * budget: the broadleaf scan models every leaf in about 60 triangles, two million in all;
 * a quarter of them (`ratio`) still shows each leaf's shape from a step away, and is
 * affordable for the few dozen trees that stand that close in a forest. Its impostor gets
 * twice the resolution to stay sharp up close.
 */
const SPECIES: { id: string; groups?: string[][]; ratio?: number; maxPixels: number; resolution?: number; frames?: number; cull?: number }[] = [
  { id: "tree_small_02", ratio: 0.25, maxPixels: 900, resolution: 256, frames: 10 },
  { id: "searsia_lucida", groups: [["searsia_lucida_a_LOD0"], ["searsia_lucida_e_LOD0"]], maxPixels: 300 },
  { id: "pine_sapling_small", groups: [["pine_sapling_small_a"], ["pine_sapling_small_b"]], maxPixels: 300 },
  { id: "shrub_02", groups: [["shrub_02_a"], ["shrub_02_c"]], maxPixels: 300, cull: 2 },
  // garden perennials and vegetables
  { id: "fern_02", groups: [["fern_02_a"], ["fern_02_b"]], maxPixels: 200, cull: 2 },
  { id: "nettle_plant", groups: [["nettle_plant_medium_a_LOD0"], ["nettle_plant_tall_a_LOD0"]], maxPixels: 200, cull: 2 },
];

export async function trees(plan: Plan): Promise<InstancedLod[]> {
  const lods: InstancedLod[] = [];
  for (const { id, groups, ratio, maxPixels, resolution, frames, cull } of SPECIES) {
    const spots = plan.models.get(id) ?? [];
    if (spots.length === 0) continue;
    const scans = await variants(id, groups);
    const sources = ratio === undefined ? scans : await Promise.all(scans.map((scan) => simplify(scan, { ratio })));
    const built = await step(id, () =>
      spread(
        id,
        sources,
        spots,
        async (source) => {
          const far = await impostor(source, { maxPixels, resolution, frames });
          return cull === undefined ? [far] : [far, culled(cull)];
        },
        foliageTint,
      ),
    );
    for (const lod of built) foliageLevels(lod, MODEL_FOLIAGE);
    lods.push(...built);
  }
  return lods;
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

import { ImpostorMesh, InstancedLod, type SwayOptions } from "@drawcall/lod";
import * as THREE from "three/webgpu";
import { Random } from "../content/random.ts";
import { step } from "../loading.ts";
import { foliageLevels } from "../content/foliage.ts";
import { MODEL_FOLIAGE } from "../content/models.ts";
import { culled, spread, type Level } from "./levels.ts";
import type { Plan } from "./plan.ts";
import { Stream, type Family } from "./stream.ts";
import { trees as loadTrees, type Species, type Tree } from "./trees/data.ts";
import { demand, culledDemand } from "./trees/demand.ts";
import { modelBounds } from "./model-bounds.ts";

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
const SPECIES: Species[] = [
  { id: "tree_small_02", ratio: 0.25, maxPixels: 900, resolution: 256, frames: 10 },
  { id: "searsia_lucida", groups: [["searsia_lucida_a_LOD0"], ["searsia_lucida_e_LOD0"]], maxPixels: 300 },
  { id: "pine_sapling_small", groups: [["pine_sapling_small_a"], ["pine_sapling_small_b"]], maxPixels: 300 },
  { id: "shrub_02", groups: [["shrub_02_a"], ["shrub_02_c"]], maxPixels: 300, cull: 2 },
  // garden perennials and vegetables
  { id: "fern_02", groups: [["fern_02_a"], ["fern_02_b"]], maxPixels: 200, cull: 2, defer: true },
  { id: "nettle_plant", groups: [["nettle_plant_medium_a_LOD0"], ["nettle_plant_tall_a_LOD0"]], maxPixels: 200, cull: 2, defer: true },
];

export async function trees(plan: Plan): Promise<Family[]> {
  return Promise.all(
    SPECIES.filter(({ id }) => (plan.models.get(id)?.length ?? 0) > 0).map((species) =>
      step(species.id, async () => {
        const { id, maxPixels, cull } = species;
        const spots = plan.models.get(id);
        if (!spots) throw new Error(`No placements for ${id}`);
        let pending: ReturnType<typeof loadTrees> | undefined;
        const load = () => (pending ??= loadTrees(species));
        const shapes = new WeakMap<InstancedLod, SwayOptions>();
        const build = async (detailed: boolean) => {
          const data = await load();
          const sources = detailed ? await data.sources() : data.trees.map(card);
          if (sources.length !== data.trees.length) throw new Error(`${id}: cached variant count differs from its source`);
          const lods = await spread(
            id,
            sources,
            spots,
            async (_, variant) => {
              const tree = data.trees[variant];
              if (!tree) throw new Error(`${id}: missing variant ${variant}`);
              const levels: Level[] = detailed ? [{ object: card(tree), maxPixels }] : [];
              if (cull !== undefined) levels.push(culled(cull));
              return levels;
            },
            foliageTint,
            detailed,
          );
          for (const lod of lods) {
            const index = sources.indexOf(lod.levels[0]?.object ?? lod);
            const tree = data.trees[index];
            if (!tree) throw new Error(`${lod.name}: missing wind shape`);
            shapes.set(lod, { amplitude: tree.amplitude, baseY: tree.impostor.box[1], height: tree.impostor.box[4] - tree.impostor.box[1] });
            foliageLevels(lod, MODEL_FOLIAGE);
          }
          return { lods, trees: data.trees, sources };
        };
        let far: InstancedLod[] = [];
        let needed: (camera: THREE.Camera) => boolean;
        if (species.defer) {
          if (cull === undefined) throw new Error(`${id}: a deferred family needs an empty far level`);
          needed = culledDemand(spots, modelBounds(id), cull);
        } else {
          const built = await build(false);
          far = built.lods;
          needed = demand(far, built.trees, built.sources, maxPixels);
        }
        return new Stream(
          id,
          far,
          async () => (await build(true)).lods,
          needed,
          (root, wind) => {
            for (const lod of root.children) {
              if (!(lod instanceof InstancedLod)) throw new Error(`${id}: unexpected tree child`);
              const shape = shapes.get(lod);
              if (!shape) throw new Error(`${lod.name}: no wind metadata`);
              wind.apply(lod, shape);
            }
          },
          (old) => {
            // All old regions are detached; new cards already retain the atlas textures.
            for (const lod of old) {
              if (!(lod instanceof InstancedLod)) throw new Error(`${id}: unexpected retired tree child`);
              lod.dispose();
            }
          },
        );
      }),
    ),
  );
}

function card(tree: Tree): ImpostorMesh {
  const mesh = new ImpostorMesh(tree.impostor);
  mesh.name = tree.name;
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
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

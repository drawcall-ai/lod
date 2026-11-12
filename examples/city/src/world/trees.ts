import type { Wind } from "@drawcall/lod";
import * as THREE from "three/webgpu";
import seedrandom from "seedrandom";
import { scripts } from "../loading.ts";
import { sourceBox } from "./bounds.ts";
import { planter, type Planting } from "./planting.ts";
import { Use } from "./land.ts";
import { copiesAt, Scatter } from "./scatter.ts";
import { inForest, type Plan, type Spot } from "./plan.ts";

/** Edge of a forest tile (m), and how far from the camera forests are held: all of the world from the tour's height. */
const TILE = 96;
const RADIUS = 6000;
/** Trees per square metre on a forest's grid. */
const DENSITY = 1 / 5.5 ** 2;
/** How far inside a forest's edge its shrubs and saplings thicken (m). */
const EDGE = 14;

/** What a forest grows, with the share of its spots each takes and how large. */
type Mix = { id: string; share: number; scale: [number, number] }[];
const INSIDE: Mix = [
  { id: "tree_small_02", share: 0.62, scale: [2.2, 3.2] },
  { id: "searsia_lucida", share: 0.18, scale: [1.8, 2.6] },
  { id: "shrub_02", share: 0.1, scale: [1, 1.6] },
  { id: "pine_sapling_small", share: 0.1, scale: [2.4, 3.4] },
];
const BORDER: Mix = [
  { id: "shrub_02", share: 0.45, scale: [0.9, 1.6] },
  { id: "pine_sapling_small", share: 0.25, scale: [1.6, 3.4] },
  { id: "searsia_lucida", share: 0.18, scale: [1.8, 2.6] },
  { id: "tree_small_02", share: 0.12, scale: [2.2, 3.2] },
];

/**
 * Trees, shrubs and garden perennials (Poly Haven scans, every leaf a card, as assets in public/models), by species, an
 * asset per variant.
 */
const SPECIES: Record<string, string[]> = {
  tree_small_02: ["/models/tree_small_02/index.glts"],
  searsia_lucida: ["/models/searsia_lucida/index.glts?variant=a", "/models/searsia_lucida/index.glts?variant=e"],
  pine_sapling_small: ["/models/pine_sapling_small/index.glts?variant=a", "/models/pine_sapling_small/index.glts?variant=b"],
  shrub_02: ["/models/shrub_02/index.glts?variant=a", "/models/shrub_02/index.glts?variant=c"],
  fern_02: ["/models/fern_02/index.glts?variant=a", "/models/fern_02/index.glts?variant=b"],
  nettle_plant: ["/models/nettle_plant/index.glts?variant=medium", "/models/nettle_plant/index.glts?variant=tall"],
};

/**
 * The trees the plan placed, and the forests, planted on the GPU by `renderer` in the tiles near the camera (`update`
 * them before each frame); each species variant one asset for both.
 */
export async function trees(plan: Plan, renderer: THREE.Renderer, wind?: Wind): Promise<THREE.Group> {
  const root = new THREE.Group();
  root.name = "trees";
  const scatter = new Scatter(scripts);
  const urlsOf = (id: string) => {
    const urls = SPECIES[id];
    if (!urls) throw new Error(`No species ${id}`);
    return urls;
  };
  const placing = Object.entries(SPECIES).flatMap(([id, urls]) => {
    const variants: Spot[][] = urls.map(() => []);
    for (const [index, spot] of (plan.models.get(id) ?? []).entries()) variants[((index * 2654435761) % 4294967296) % urls.length]?.push(spot);
    return urls.flatMap((url, variant) => {
      const mine = variants[variant] ?? [];
      return mine.length
        ? [
            scatter.place(
              url,
              copiesAt(mine, (spot) => foliageTint(Math.round(spot.x * 7 + spot.z * 13))),
            ),
          ]
        : [];
    });
  });

  const plant = planter(plan, scatter, renderer);
  const forest = (x: number, z: number) => plan.land.at(x, z) === Use.Forest;
  const inside = (x: number, z: number) => plan.forests.some((f) => inForest(f, x, z, -EDGE));
  const mixes: [string, Mix, (x: number, z: number) => boolean][] = [
    ["forest", INSIDE, (x, z) => forest(x, z) && inside(x, z)],
    ["forest edge", BORDER, (x, z) => forest(x, z) && !inside(x, z)],
  ];
  const stands = mixes.map(([name, mix, grows]) => {
    const plantings: Planting[] = mix.flatMap(({ id, share, scale }) => {
      const urls = urlsOf(id);
      return urls.map((url) => ({ url, share: share / urls.length, scale, tinted: true }));
    });
    return plant({ name, tile: TILE, density: DENSITY, radius: RADIUS, grows }, plantings);
  });
  const [planted] = await Promise.all([Promise.all(stands), Promise.all(placing)]);
  await scatter.seal();
  if (wind)
    for (const lod of await scatter.lods()) {
      const box = sourceBox(lod.levels);
      wind.apply(lod, { amplitude: (box.max.y - box.min.y) * 0.025 });
    }
  root.add(scatter, ...planted);
  return root;
}

/** Every tree a little different: lighter or darker, yellower or bluer green. */
function foliageTint(seed: number): THREE.Color {
  const r = seedrandom(String(seed));
  return new THREE.Color(1, 1, 1).multiplyScalar(0.82 + 0.28 * r()).lerp(r() < 0.5 ? YELLOWER : BLUER, 0.35 * r());
}

const YELLOWER = new THREE.Color(1.1, 1.05, 0.7);
const BLUER = new THREE.Color(0.85, 0.95, 1.0);

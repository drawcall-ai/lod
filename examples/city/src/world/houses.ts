import { CachedLodLoader, Lod, type LodGpu, type LodLevel } from "@drawcall/lod";
import * as THREE from "three/webgpu";
import { HOUSE_VARIANTS } from "../../public/house/params.ts";
import seedrandom from "seedrandom";
import { arriving, manager } from "../loading.ts";
import { instancedAt } from "./place.ts";
import type { Plan } from "./plan.ts";

const WARMER = new THREE.Color(1.05, 0.98, 0.88);

/** Derived levels cast and receive shadows. */
const shadows = arriving((object, index) => {
  if (index > 0) object.castShadow = object.receiveShadow = true;
});

/** Each house variant: the source, its windows baked onto its authored low shell, then an impostor. */
const HOUSES: (() => Promise<LodLevel[]>)[] = [
  () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/house/index.glts?variant=0",
      levels: [
        { type: "baked", low: "/house/low.glts?variant=0", interior: "/house/interior.glts?variant=0", textureSize: 512, maxPixels: 350 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 90 },
      ],
    }),
  () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/house/index.glts?variant=1",
      levels: [
        { type: "baked", low: "/house/low.glts?variant=1", interior: "/house/interior.glts?variant=1", textureSize: 512, maxPixels: 350 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 90 },
      ],
    }),
  () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/house/index.glts?variant=2",
      levels: [
        { type: "baked", low: "/house/low.glts?variant=2", interior: "/house/interior.glts?variant=2", textureSize: 512, maxPixels: 350 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 90 },
      ],
    }),
  () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/house/index.glts?variant=3",
      levels: [
        { type: "baked", low: "/house/low.glts?variant=3", interior: "/house/interior.glts?variant=3", textureSize: 512, maxPixels: 350 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 90 },
      ],
    }),
  () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/house/index.glts?variant=4",
      levels: [
        { type: "baked", low: "/house/low.glts?variant=4", interior: "/house/interior.glts?variant=4", textureSize: 512, maxPixels: 350 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 90 },
      ],
    }),
  () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/house/index.glts?variant=5",
      levels: [
        { type: "baked", low: "/house/low.glts?variant=5", interior: "/house/interior.glts?variant=5", textureSize: 512, maxPixels: 350 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 90 },
      ],
    }),
  () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/house/index.glts?variant=6",
      levels: [
        { type: "baked", low: "/house/low.glts?variant=6", interior: "/house/interior.glts?variant=6", textureSize: 512, maxPixels: 350 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 90 },
      ],
    }),
  () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/house/index.glts?variant=7",
      levels: [
        { type: "baked", low: "/house/low.glts?variant=7", interior: "/house/interior.glts?variant=7", textureSize: 512, maxPixels: 350 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 90 },
      ],
    }),
  () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/house/index.glts?variant=8",
      levels: [
        { type: "baked", low: "/house/low.glts?variant=8", interior: "/house/interior.glts?variant=8", textureSize: 512, maxPixels: 350 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 90 },
      ],
    }),
  () =>
    new CachedLodLoader(manager, shadows).loadAsync({
      url: "/house/index.glts?variant=9",
      levels: [
        { type: "baked", low: "/house/low.glts?variant=9", interior: "/house/interior.glts?variant=9", textureSize: 512, maxPixels: 350 },
        { type: "impostor", layout: "hemi", frames: 8, resolution: 64, maxPixels: 90 },
      ],
    }),
];

if (HOUSES.length !== HOUSE_VARIANTS) throw new Error(`houses.ts loads ${HOUSES.length} house variants of ${HOUSE_VARIANTS}`);

const church = () =>
  new CachedLodLoader(manager, shadows).loadAsync({
    url: "/house/church/index.glts",
    levels: [
      { type: "baked", low: "/house/church/low.glts", interior: "/house/church/interior.glts", textureSize: 1024, maxPixels: 560 },
      { type: "impostor", layout: "hemi", frames: 8, resolution: 128, maxPixels: 144 },
    ],
  });

export async function houses(plan: Plan, gpu: LodGpu): Promise<THREE.Group> {
  const root = new THREE.Group();
  root.name = "houses";
  const homes = HOUSES.map(async (load, variant) => {
    const spots = plan.houses.filter((house) => house.variant === variant).map((house) => house.spot);
    if (!spots.length) return [];
    const levels = await load();
    return [
      instancedAt(gpu, `house ${variant}`, levels, spots, (_, index, color) => {
        const random = seedrandom(String(index * 31 + variant));
        return color.multiplyScalar(0.88 + 0.16 * random()).lerp(WARMER, 0.4 * random());
      }),
    ];
  });
  const [variants, levels] = await Promise.all([Promise.all(homes), church()]);
  const building = new Lod(levels, gpu);
  building.name = "church";
  building.position.set(plan.church.x, plan.church.y, plan.church.z);
  building.rotation.y = plan.church.angle;
  root.add(...variants.flat(), building);
  return root;
}

import * as THREE from "three/webgpu";
import { cameraPosition, distance, float, positionWorld, vec4 } from "three/tsl";
import {
  CachedLodLoader,
  foliageLevels,
  foliageModel,
  ImpostorMesh,
  Lod,
  type CachedLodLoaderOptions,
  type LodGpu,
  type LodLevel,
  type Wind,
} from "@drawcall/lod";
import { sourceBox } from "./bounds.ts";
import { planter } from "./planting.ts";
import { arriving, manager } from "../loading.ts";
import { MODEL_FOLIAGE } from "./foliage.ts";
import type { Textures } from "../render/materials.ts";
import type { Zones } from "./zones.ts";
import { groundShading, type Ground } from "../render/ground/shading.ts";
import { Use } from "./land.ts";
import { reachFor } from "./screen.ts";
import { type Plan, TOWN } from "./plan.ts";

/** Edge of a ground-cover tile (m). */
const TILE = 6;

/** Where a kind grows: town gardens, the open country's grassland, or the forest floor. */
type Habitat = "garden" | "meadow" | "forest";

/**
 * A kind of ground cover: patches of generated grass blades, or a fetched plant model, as the ladders of its variants.
 * Their empty threshold is a stand-in the cover replaces from the loaded bounds; grass, given the ground it takes its
 * colour from, replaces its impostor's too.
 */
interface GroundKind {
  name: string;
  ground: Habitat;
  density: number;
  reach: number;
  scale: [number, number];
  grass: boolean;
  models: (ground: Ground) => Promise<LodLevel[]>[];
}

/**
 * Ground cover near the camera: grass blade by blade, wild flowers on the meadows, ferns and nettles on the forest
 * floor. A kilometre of meadow holds far too many blades to list, and from a few dozen metres on the ground texture
 * shows the same green (the blades take their colour from it), so each kind is planted on the GPU in 6 m tiles only
 * within the distance where it still stands taller than its cull size on screen; there it dithers out into the empty
 * level. The cull size is set so that happens `reach` metres away on an 800 px tall screen (a 50° field of view).
 * Every kind switches directly from its original geometry to an impostor, then disappears into the ground.
 */
const GROUND_COVER: GroundKind[] = [
  {
    name: "lawn",
    ground: "garden",
    density: 4,
    reach: 18,
    scale: [0.9, 1.1],
    grass: true,
    models: (ground) => [
      new CachedLodLoader(manager, grass(ground)).loadAsync({
        url: "/grass/index.glts?kind=lawn&variant=0",
        levels: [
          { type: "impostor", layout: "hemi", resolution: 64 },
          { type: "empty", maxPixels: 1 },
        ],
      }),
      new CachedLodLoader(manager, grass(ground)).loadAsync({
        url: "/grass/index.glts?kind=lawn&variant=1",
        levels: [
          { type: "impostor", layout: "hemi", resolution: 64 },
          { type: "empty", maxPixels: 1 },
        ],
      }),
    ],
  },
  {
    name: "meadow",
    ground: "meadow",
    density: 4,
    reach: 22,
    scale: [0.8, 1.25],
    grass: true,
    models: (ground) => [
      new CachedLodLoader(manager, grass(ground)).loadAsync({
        url: "/grass/index.glts?kind=meadow&variant=0",
        levels: [
          { type: "impostor", layout: "hemi", resolution: 64 },
          { type: "empty", maxPixels: 1 },
        ],
      }),
      new CachedLodLoader(manager, grass(ground)).loadAsync({
        url: "/grass/index.glts?kind=meadow&variant=1",
        levels: [
          { type: "impostor", layout: "hemi", resolution: 64 },
          { type: "empty", maxPixels: 1 },
        ],
      }),
    ],
  },
  {
    name: "dandelions",
    ground: "meadow",
    density: 0.35,
    reach: 45,
    scale: [0.8, 1.2],
    grass: false,
    models: () => [
      new CachedLodLoader(manager, plant).loadAsync({
        url: "/assets/models/dandelion_01/dandelion_01_a_LOD0.glb",
        levels: [
          { type: "impostor", layout: "hemi", resolution: 64, maxPixels: 64 },
          { type: "empty", maxPixels: 1 },
        ],
      }),
      new CachedLodLoader(manager, plant).loadAsync({
        url: "/assets/models/dandelion_01/dandelion_01_c_LOD0.glb",
        levels: [
          { type: "impostor", layout: "hemi", resolution: 64, maxPixels: 64 },
          { type: "empty", maxPixels: 1 },
        ],
      }),
    ],
  },
  {
    name: "ferns",
    ground: "forest",
    density: 0.3,
    reach: 40,
    scale: [0.8, 1.4],
    grass: false,
    models: () => [
      new CachedLodLoader(manager, plant).loadAsync({
        url: "/assets/models/fern_02/fern_02_a.glb",
        levels: [
          { type: "impostor", layout: "hemi", resolution: 64, maxPixels: 64 },
          { type: "empty", maxPixels: 1 },
        ],
      }),
      new CachedLodLoader(manager, plant).loadAsync({
        url: "/assets/models/fern_02/fern_02_b.glb",
        levels: [
          { type: "impostor", layout: "hemi", resolution: 64, maxPixels: 64 },
          { type: "empty", maxPixels: 1 },
        ],
      }),
    ],
  },
  {
    name: "nettles",
    ground: "forest",
    density: 0.12,
    reach: 40,
    scale: [0.9, 1.3],
    grass: false,
    models: () => [
      new CachedLodLoader(manager, plant).loadAsync({
        url: "/assets/models/nettle_plant/nettle_plant_medium_a_LOD0.glb",
        levels: [
          { type: "impostor", layout: "hemi", resolution: 64, maxPixels: 64 },
          { type: "empty", maxPixels: 1 },
        ],
      }),
      new CachedLodLoader(manager, plant).loadAsync({
        url: "/assets/models/nettle_plant/nettle_plant_tall_a_LOD0.glb",
        levels: [
          { type: "impostor", layout: "hemi", resolution: 64, maxPixels: 64 },
          { type: "empty", maxPixels: 1 },
        ],
      }),
    ],
  },
];

/** Ground cover, planted on the GPU in the tiles near `camera`: `update` them before each frame. */
export async function groundCover(textures: Textures, plan: Plan, zones: Zones, camera: THREE.Camera, gpu: LodGpu, wind?: Wind): Promise<THREE.Group> {
  // Grass samples ground in the vertex stage, where pixel derivatives are unavailable.
  const ground = groundShading(textures, zones, float(0));
  const root = new THREE.Group();
  root.name = "ground cover";
  const reference = new THREE.PerspectiveCamera(50);
  const plant = planter(plan, gpu);
  const loaded = await Promise.all(
    GROUND_COVER.map(async (kind) => {
      const models = await Promise.all(kind.models(ground));
      const boxes = models.map(sourceBox);
      const size = Math.max(...boxes.map((box) => box.getSize(new THREE.Vector3()).length())) * kind.scale[1];
      const cull = reachFor(reference, size, kind.reach, 800, 1);
      // on a screen 1080 pixels tall, where the levels end
      const radius = reachFor(reference, size, cull, 1080, Lod.quality);
      const cover = plant(
        { name: kind.name, tile: TILE, density: kind.density, radius, grows: where(plan, kind.ground) },
        models.map((levels, variant) => ({
          name: `${kind.name} ${variant}`,
          levels,
          from: variant / models.length,
          to: (variant + 1) / models.length,
          scale: kind.scale,
        })),
      );
      cover.lods.forEach((lod, variant) => {
        const middle = lod.levels[1];
        const empty = lod.levels.at(-1);
        const box = boxes[variant];
        if (!middle || !empty || !box) throw new Error(`${kind.name}: incomplete ground cover levels`);
        // The cull size follows from the loaded bounds, so the requested empty threshold is a stand-in.
        if (kind.grass) middle.maxPixels = cull * 4;
        empty.maxPixels = cull;
        // The field thins out over the last 40 % of the radius and ends at it, where the levels end.
        lod.cullDistance = { camera, near: radius * 0.6, far: radius };
        wind?.apply(lod, { amplitude: (box.max.y - box.min.y) * 0.07 });
      });
      return cover;
    }),
  );
  root.add(...loaded);
  return root;
}

/** Plant models' levels cast no shadow but receive them. */
const plant = arriving((object) => {
  foliageModel(object, MODEL_FOLIAGE);
  foliageLevels(object, MODEL_FOLIAGE);
  object.traverse((node) => {
    node.castShadow = false;
    node.receiveShadow = true;
  });
});

/** Grass levels take their colour from `ground` below them, which the blades are shaded neutral for. */
function grass(ground: Ground): CachedLodLoaderOptions {
  const base = ground(positionWorld.xz, distance(cameraPosition.xz, positionWorld.xz));
  const carried = base.toVarying("vGrassGround");
  return arriving((object) => {
    foliageLevels(object, { translucency: 0.5 });
    object.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const material = node.material;
      if (!(material instanceof THREE.MeshStandardNodeMaterial) || !material.colorNode) throw new Error("Grass levels need their authored colour node");
      // Both representations contain the same neutral blade shading; ground colour is applied after baking.
      const original = material.colorNode;
      // An impostor already uses all the varyings WebGPU allows; it covers few pixels, so it reads the ground per pixel.
      material.colorNode = new THREE.ConvertNode<"vec4">(original, "vec4").mul(vec4(node instanceof ImpostorMesh ? base : carried, 1));
      node.castShadow = false;
      node.receiveShadow = true;
    });
  });
}

/** Which ground a kind grows on, as a test on x, z. */
function where(plan: Plan, ground: Habitat): (x: number, z: number) => boolean {
  const inTown = (x: number, z: number) => Math.hypot(x - TOWN.x, z - TOWN.z) < TOWN.radius + 40;
  if (ground === "forest") return (x, z) => plan.land.at(x, z) === Use.Forest;
  if (ground === "garden") return (x, z) => plan.land.at(x, z) === Use.Lawn && inTown(x, z);
  return (x, z) => plan.land.at(x, z) === Use.Lawn && !inTown(x, z);
}

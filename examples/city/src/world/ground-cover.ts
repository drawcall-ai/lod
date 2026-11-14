import * as THREE from "three/webgpu";
import { float, vec3 } from "three/tsl";
import { Lod, type Wind } from "@drawcall/lod";
import { sourceBox } from "./bounds.ts";
import { planter, type Stand } from "./planting.ts";
import { scripts } from "../loading.ts";
import type { Textures } from "../render/materials.ts";
import type { Zones } from "./zones.ts";
import { groundShading } from "../render/ground/shading.ts";
import { Use } from "./land.ts";
import { reachFor } from "./screen.ts";
import { type Plan, TOWN } from "./plan.ts";
import { Scatter } from "./scatter.ts";
import { GREEN } from "../../public/grass/green.ts";

/** Edge of a ground-cover tile (m). */
const TILE = 6;

/** Where a kind grows: town gardens, the open country's grassland, or the forest floor. */
type Habitat = "garden" | "meadow" | "forest";

/** A kind of ground cover: patches of generated grass blades, or a fetched plant model, as the assets of its variants. */
interface GroundKind {
  name: string;
  ground: Habitat;
  density: number;
  reach: number;
  scale: [number, number];
  grass: boolean;
  urls: string[];
}

/**
 * Ground cover near the camera: grass blade by blade, wild flowers on the meadows, ferns and nettles on the forest
 * floor. A kilometre of meadow holds far too many blades to list, and from a few dozen metres on the ground texture
 * shows the same green (the blades take their colour from it), so each kind is planted on the GPU in 6 m tiles only
 * within the distance where it still stands taller than its cull size on screen; there it dithers out into the empty
 * level. The cull size is set so that happens `reach` metres away on an 800 px tall screen (a 50° field of view).
 */
const GROUND_COVER: GroundKind[] = [
  {
    name: "lawn",
    ground: "garden",
    density: 4,
    reach: 18,
    scale: [0.9, 1.1],
    grass: true,
    urls: ["/grass/index.glts?kind=lawn&variant=0", "/grass/index.glts?kind=lawn&variant=1"],
  },
  {
    name: "meadow",
    ground: "meadow",
    density: 4,
    reach: 22,
    scale: [0.8, 1.25],
    grass: true,
    urls: ["/grass/index.glts?kind=meadow&variant=0", "/grass/index.glts?kind=meadow&variant=1"],
  },
  {
    name: "dandelions",
    ground: "meadow",
    density: 0.35,
    reach: 45,
    scale: [0.8, 1.2],
    grass: false,
    urls: ["/models/dandelion_01/index.glts?variant=a", "/models/dandelion_01/index.glts?variant=c"],
  },
  {
    name: "ferns",
    ground: "forest",
    density: 0.3,
    reach: 40,
    scale: [0.8, 1.4],
    grass: false,
    urls: ["/models/fern_02/index.glts?variant=a", "/models/fern_02/index.glts?variant=b"],
  },
  {
    name: "nettles",
    ground: "forest",
    density: 0.12,
    reach: 40,
    scale: [0.9, 1.3],
    grass: false,
    urls: ["/models/nettle_plant/index.glts?variant=medium", "/models/nettle_plant/index.glts?variant=tall"],
  },
];

/**
 * Ground cover, planted on the GPU by `renderer` in the tiles near `camera` (`update` them before each frame), its
 * assets drawn apart from the gardens' and casting no shadows. Grass takes the colour of the ground under it.
 */
export async function groundCover(
  textures: Textures,
  plan: Plan,
  zones: Zones,
  camera: THREE.Camera,
  renderer: THREE.Renderer,
  wind?: Wind,
): Promise<THREE.Group> {
  // Sampled in a compute pass, where pixel derivatives are unavailable: near, where grass grows.
  const ground = groundShading(textures, zones, float(0));
  // Grass takes the ground's colour in place of the green its asset draws with on its own.
  const grassColor = (xz: THREE.Node<"vec2">) => ground(xz, float(0)).div(vec3(...GREEN));
  const scatter = new Scatter(scripts);
  const root = new THREE.Group();
  root.name = "ground cover";
  const reference = new THREE.PerspectiveCamera(50);
  const plant = planter(plan, scatter, renderer);
  const kinds = await Promise.all(
    GROUND_COVER.map(async (kind) => {
      const lods = await Promise.all(kind.urls.map((url) => scatter.lod(url)));
      const boxes = lods.map(({ levels }) => sourceBox(levels));
      const size = Math.max(...boxes.map((box) => box.getSize(new THREE.Vector3()).length())) * kind.scale[1];
      const cull = reachFor(reference, size, kind.reach, 800, 1);
      // on a screen 1080 pixels tall, where the levels end
      const radius = reachFor(reference, size, cull, 1080, Lod.quality);
      const cover = await plant(
        { name: kind.name, tile: TILE, density: kind.density, radius, ...where(kind.ground) },
        kind.urls.map((url) => ({ url, share: 1 / kind.urls.length, scale: kind.scale, color: kind.grass ? grassColor : undefined })),
      );
      return { kind, lods, boxes, cull, radius, cover };
    }),
  );
  await scatter.seal();
  for (const { kind, lods, boxes, cull, radius } of kinds)
    lods.forEach((lod, variant) => {
      const middle = lod.levels[1];
      const empty = lod.levels.at(-1);
      const box = boxes[variant];
      if (!middle || !empty || !box) throw new Error(`${kind.name}: incomplete ground cover levels`);
      // The cull size follows from the loaded bounds, so the asset's empty threshold is a stand-in.
      if (kind.grass) middle.maxPixels = cull * 4;
      empty.maxPixels = cull;
      // The field thins out over the last 40 % of the radius and ends at it, where the levels end.
      lod.cullDistance = { camera, near: radius * 0.6, far: radius };
      wind?.apply(lod, { amplitude: (box.max.y - box.min.y) * 0.07 });
      lod.addEventListener("levelschange", () => lod.traverse((node) => (node.castShadow = false)));
    });
  root.add(scatter, ...kinds.map(({ cover }) => cover));
  return root;
}

/** Which land a kind grows on, and where on it. */
function where(habitat: Habitat): Pick<Stand, "ground" | "grows"> {
  const inTown = (x: number, z: number) => Math.hypot(x - TOWN.x, z - TOWN.z) < TOWN.radius + 40;
  if (habitat === "forest") return { ground: Use.Forest };
  if (habitat === "garden") return { ground: Use.Lawn, grows: inTown };
  return { ground: Use.Lawn, grows: (x, z) => !inTown(x, z) };
}

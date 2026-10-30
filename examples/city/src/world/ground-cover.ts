import * as THREE from "three/webgpu";
import { cameraPosition, distance, float, positionWorld, vec4 } from "three/tsl";
import { InstancedLod, Lod, type LodLevel, type Wind } from "@drawcall/lod";
import { sourceBox } from "./bounds.ts";
import { Random } from "../../public/content/random.ts";
import { loader } from "../loading.ts";
import { foliageLevels, foliageModel, MODEL_FOLIAGE } from "../../public/content/foliage.ts";
import type { Library } from "../../public/content/materials.ts";
import type { Zones } from "./zones.ts";
import { groundShading, type Ground } from "../render/ground/shading.ts";
import { Use } from "./land.ts";
import { Patches, reachFor, type Tiles } from "./patches.ts";
import { type Plan, TOWN } from "./plan.ts";

/** Edge of a ground-cover tile (m). */
const TILE = 6;

/** Where a kind grows: town gardens, the open country's grassland, or the forest floor. */
type Habitat = "garden" | "meadow" | "forest";

/** A kind of ground cover: patches of generated grass blades, or a fetched plant model. */
type Kind = { name: string; ground: Habitat; density: number; reach: number; scale: [number, number] } & (
  { grass: true; variants: number } | { id: string; variants: string[] }
);

/**
 * Ground cover near the camera: grass blade by blade, wild flowers on the meadows, ferns
 * and nettles on the forest floor. A kilometre of meadow holds far too many blades to
 * list, and from a few dozen metres on the ground texture shows the same green (the
 * blades take their colour from it), so each kind lives in `Patches` of 6 m tiles filled
 * only within the distance where it still stands taller than its cull size on screen;
 * there it dithers out into the empty level. The cull size is set so that happens `reach`
 * metres away on an 800 px tall view (a 50° field of view). Every kind switches directly
 * from its original geometry to an impostor, then disappears into the ground.
 */
const KINDS: Kind[] = [
  {
    name: "lawn",
    ground: "garden",
    grass: true,
    variants: 2,
    density: 4,
    reach: 18,
    scale: [0.9, 1.1],
  },
  {
    name: "meadow",
    ground: "meadow",
    grass: true,
    variants: 2,
    density: 4,
    reach: 22,
    scale: [0.8, 1.25],
  },
  {
    name: "dandelions",
    ground: "meadow",
    id: "dandelion_01",
    variants: ["dandelion_01_a_LOD0", "dandelion_01_c_LOD0"],
    density: 0.35,
    reach: 45,
    scale: [0.8, 1.2],
  },
  { name: "ferns", ground: "forest", id: "fern_02", variants: ["fern_02_a", "fern_02_b"], density: 0.3, reach: 40, scale: [0.8, 1.4] },
  {
    name: "nettles",
    ground: "forest",
    id: "nettle_plant",
    variants: ["nettle_plant_medium_a_LOD0", "nettle_plant_tall_a_LOD0"],
    density: 0.12,
    reach: 40,
    scale: [0.9, 1.3],
  },
];

export async function groundCover(library: Library, plan: Plan, zones: Zones, wind?: Wind): Promise<THREE.Group> {
  // Grass samples ground in the vertex stage, where pixel derivatives are unavailable.
  const ground = groundShading(library, zones, float(0));
  const root = new THREE.Group();
  root.name = "ground cover";
  const reference = new THREE.PerspectiveCamera(50);
  const loaded = await Promise.all(
    KINDS.map(async (kind) => {
      const models = await ("grass" in kind ? grassModels(kind, ground) : plantModels(kind));
      const boxes = models.map(sourceBox);
      const size = Math.max(...boxes.map((box) => box.getSize(new THREE.Vector3()).length())) * kind.scale[1];
      const cull = reachFor(reference, size, kind.reach, 800, 1);
      const chunks = Math.ceil((Math.PI * (2 * kind.reach + TILE) ** 2) / (TILE * TILE));
      const tiles = new GroundTiles(plan, kind.density, where(plan, kind.ground), kind.scale, models.length);
      const lods = models.map((model, variant) => {
        const lod = new InstancedLod(model, chunks * tiles.perVariant);
        const middle = lod.levels[1];
        const empty = lod.levels.at(-1);
        const box = boxes[variant];
        if (!middle || !empty || !box) throw new Error(`${kind.name}: incomplete ground cover levels`);
        // The cull size follows from the loaded bounds, so the requested empty threshold is a stand-in.
        if ("grass" in kind) middle.maxPixels = cull * 4;
        empty.maxPixels = cull;

        lod.name = `${kind.name} ${variant}`;
        wind?.apply(lod, { amplitude: (box.max.y - box.min.y) * 0.07 });
        return lod;
      });
      const patches = new Patches(
        lods,
        lods.map(() => tiles.perVariant),
        chunks,
        tiles,
        (camera) => reachFor(camera, size, cull, Patches.height, Lod.quality),
      );
      patches.name = kind.name;
      return patches;
    }),
  );
  root.add(...loaded);
  return root;
}

async function plantModels(kind: Kind & { id: string; variants: string[] }): Promise<LodLevel[][]> {
  return Promise.all(
    kind.variants.map(async (variant) => {
      const levels = await loader.loadAsync({
        url: `/assets/models/${kind.id}/${variant}.glb`,
        levels: [
          { type: "impostor", layout: "hemi", resolution: 64, maxPixels: 64 },
          { type: "empty", maxPixels: 1 },
        ],
        onLevel: (object) => {
          foliageModel(object, MODEL_FOLIAGE);
          foliageLevels(object, MODEL_FOLIAGE);
          object.traverse((node) => {
            node.castShadow = false;
            node.receiveShadow = true;
          });
        },
      });
      return levels;
    }),
  );
}

async function grassModels(kind: Kind & { grass: true; variants: number }, ground: Ground): Promise<LodLevel[][]> {
  const base = ground(positionWorld.xz, distance(cameraPosition.xz, positionWorld.xz)).toVarying("vGrassGround");
  return Promise.all(
    Array.from({ length: kind.variants }, async (_, variant) => {
      const levels = await loader.loadAsync({
        url: `/props/grass.glts?kind=${kind.name}&variant=${variant}`,
        levels: [
          { type: "impostor", layout: "hemi", resolution: 64 },
          { type: "empty", maxPixels: 1 },
        ],
        onLevel: (object) => {
          foliageLevels(object, { translucency: 0.5 });
          object.traverse((node) => {
            if (!(node instanceof THREE.Mesh)) return;
            const material = node.material;
            if (!(material instanceof THREE.MeshStandardNodeMaterial) || !material.colorNode) throw new Error("Grass levels need their authored colour node");
            // Both representations contain the same neutral blade shading; ground colour is applied after baking.
            const original = material.colorNode;
            material.colorNode = new THREE.ConvertNode<"vec4">(original, "vec4").mul(vec4(base, 1));
            node.castShadow = false;
            node.receiveShadow = true;
          });
        },
      });
      return levels;
    }),
  );
}

/** Which ground a kind grows on, as a test on x, z. */
function where(plan: Plan, ground: Habitat): (x: number, z: number) => boolean {
  const inTown = (x: number, z: number) => Math.hypot(x - TOWN.x, z - TOWN.z) < TOWN.radius + 40;
  if (ground === "forest") return (x, z) => plan.land.at(x, z) === Use.Forest;
  if (ground === "garden") return (x, z) => plan.land.at(x, z) === Use.Lawn && inTown(x, z);
  return (x, z) => plan.land.at(x, z) === Use.Lawn && !inTown(x, z);
}

/** An endless grid of tiles over the ground, each scattered with tufts where `grows`. */
class GroundTiles implements Tiles {
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();
  private readonly size = new THREE.Vector3();
  /** Tufts per tile side, on a jittered grid. */
  private readonly side: number;
  /** The most tufts of one variant a tile holds. */
  readonly perVariant: number;

  constructor(
    private readonly plan: Plan,
    density: number,
    private readonly grows: (x: number, z: number) => boolean,
    private readonly scale: [number, number],
    private readonly variants: number,
  ) {
    this.side = Math.max(1, Math.round(TILE * Math.sqrt(density)));
    this.perVariant = Math.ceil((this.side * this.side) / variants);
  }

  near(eye: THREE.Vector3, reach: number, visit: (tile: number, distance: number) => void): void {
    const above = Math.max(0, eye.y - this.plan.terrain.height(eye.x, eye.z));
    if (above > reach) return;
    const flat = Math.sqrt(reach * reach - above * above);
    const i0 = Math.floor((eye.x - flat) / TILE);
    const i1 = Math.floor((eye.x + flat) / TILE);
    const j0 = Math.floor((eye.z - flat) / TILE);
    const j1 = Math.floor((eye.z + flat) / TILE);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const cx = (i + 0.5) * TILE;
        const cz = (j + 0.5) * TILE;
        // to the tile's nearest point, so a tile under the camera counts as at hand
        const dx = Math.max(Math.abs(eye.x - cx) - TILE / 2, 0);
        const dz = Math.max(Math.abs(eye.z - cz) - TILE / 2, 0);
        const d = Math.hypot(dx, dz, above);
        if (d <= reach) visit(key(i, j), d);
      }
  }

  fill(tile: number, emit: (lod: number, matrix: THREE.Matrix4) => void): void {
    const i = Math.floor(tile / 65536) - 32768;
    const j = (tile % 65536) - 32768;
    const r = new Random(tile * 7919 + 13);
    const n = this.side;
    const cell = TILE / n;
    let k = r.int(0, this.variants - 1);
    for (let b = 0; b < n; b++)
      for (let a = 0; a < n; a++) {
        const x = i * TILE + (a + r.next()) * cell;
        const z = j * TILE + (b + r.next()) * cell;
        const angle = r.range(0, Math.PI * 2);
        const s = r.range(this.scale[0], this.scale[1]);
        k = (k + 1) % this.variants;
        if (!this.grows(x, z)) continue;
        this.position.set(x, this.plan.terrain.height(x, z), z);
        this.turn.setFromAxisAngle(UP, angle);
        emit(k, this.matrix.compose(this.position, this.turn, this.size.setScalar(s)));
      }
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/** A tile's id from its grid coordinates (each within ±32768). */
function key(i: number, j: number): number {
  return (i + 32768) * 65536 + (j + 32768);
}

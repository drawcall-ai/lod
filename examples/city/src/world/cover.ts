import * as THREE from "three/webgpu";
import { float } from "three/tsl";
import { InstancedLod, Lod, LodLoader, type LodLevel, type Wind } from "@drawcall/lod";
import { sourceBox } from "./bounds.ts";
import { model } from "./cache.ts";
import { Random } from "../content/random.ts";
import { step } from "../loading.ts";
import { foliageLevels, foliageModel } from "../content/foliage.ts";
import { MODEL_FOLIAGE, variants } from "../content/models.ts";
import { type ClumpShape, grassClump, grassMaterial } from "../content/grass.ts";
import { groundShading, type Zones } from "../content/terrain.ts";
import { Use } from "./land.ts";
import { Patches, reachFor, type Tiles } from "./patches.ts";
import { type Plan, TOWN } from "./plan.ts";

/** Edge of a ground-cover tile (m). */
const TILE = 6;

/** Where a kind grows: town gardens, the open country's grassland, or the forest floor. */
type Ground = "garden" | "meadow" | "forest";

/** A kind of ground cover: patches of generated grass blades, or a fetched plant model. */
type Kind = { name: string; ground: Ground; density: number; reach: number; scale: [number, number] } & (
  { grass: ClumpShape; designs: number } | { id: string; groups: string[][] }
);

/**
 * Ground cover near the camera: grass blade by blade, wild flowers on the meadows, ferns
 * and nettles on the forest floor. A kilometre of meadow holds far too many blades to
 * list, and from a few dozen metres on the ground texture shows the same green (the
 * blades take their colour from it), so each kind lives in `Patches` of 6 m tiles filled
 * only within the distance where it still stands taller than its cull size on screen;
 * there it dithers out into the empty level. The cull size is set so that happens `reach`
 * metres away on an 800 px tall view (a 50° field of view). Grass patches thin out in a
 * hand-made middle level, a third of their blades, twice as wide; plants go to an
 * impostor.
 */
const KINDS: Kind[] = [
  {
    name: "lawn",
    ground: "garden",
    grass: { size: 0.5, blades: 170, height: [0.05, 0.11], width: 0.008 },
    designs: 2,
    density: 4,
    reach: 18,
    scale: [0.9, 1.1],
  },
  {
    name: "meadow",
    ground: "meadow",
    grass: { size: 0.5, blades: 125, height: [0.12, 0.45], width: 0.01 },
    designs: 2,
    density: 4,
    reach: 22,
    scale: [0.8, 1.25],
  },
  {
    name: "dandelions",
    ground: "meadow",
    id: "dandelion_01",
    groups: [["dandelion_01_a_LOD0"], ["dandelion_01_c_LOD0"]],
    density: 0.35,
    reach: 45,
    scale: [0.8, 1.2],
  },
  { name: "ferns", ground: "forest", id: "fern_02", groups: [["fern_02_a"], ["fern_02_b"]], density: 0.3, reach: 40, scale: [0.8, 1.4] },
  {
    name: "nettles",
    ground: "forest",
    id: "nettle_plant",
    groups: [["nettle_plant_medium_a_LOD0"], ["nettle_plant_tall_a_LOD0"]],
    density: 0.12,
    reach: 40,
    scale: [0.9, 1.3],
  },
];

export async function cover(plan: Plan, zones: Zones, wind?: Wind): Promise<THREE.Group> {
  // Grass samples ground in the vertex stage, where pixel derivatives are unavailable.
  const material = grassMaterial(groundShading(zones, float(0)));
  const root = new THREE.Group();
  root.name = "ground cover";
  const reference = new THREE.PerspectiveCamera(50);
  const loaded = await Promise.all(
    KINDS.map(async (kind) => {
      const models = await step(kind.name, () => ("grass" in kind ? grassModels(kind, material) : plantModels(kind)));
      const boxes = models.map(sourceBox);
      const size = Math.max(...boxes.map((box) => box.getSize(new THREE.Vector3()).length())) * kind.scale[1];
      const cull = reachFor(reference, size, kind.reach, 800, 1);
      const chunks = Math.ceil((Math.PI * (2 * kind.reach + TILE) ** 2) / (TILE * TILE));
      const tiles = new GroundTiles(plan, kind.density, where(plan, kind.ground), kind.scale, models.length);
      const lods = models.map((model, variant) => {
        const lod = new InstancedLod(model, chunks * tiles.perKind);
        const middle = lod.levels[1];
        const empty = lod.levels[2];
        const box = boxes[variant];
        if (!middle || !empty || !box) throw new Error(`${kind.name}: incomplete cover levels`);
        middle.maxPixels = "grass" in kind ? cull * 4 : 64;
        empty.maxPixels = cull;
        lod.name = `${kind.name} ${variant + 1}`;
        wind?.apply(lod, { amplitude: (box.max.y - box.min.y) * 0.07 });
        return lod;
      });
      const patches = new Patches(
        lods,
        lods.map(() => tiles.perKind),
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

async function plantModels(kind: Kind & { id: string; groups: string[][] }): Promise<LodLevel[][]> {
  const loader = new LodLoader();
  return Promise.all(
    variants(kind.id, kind.groups).map(async (source, variant) => {
      const levels = await loader.loadAsync({
        make: source,
        reference: true,
        key: model(kind.id, variant, kind.groups),
        levels: [{ type: "impostor", layout: "hemi", resolution: 64, maxPixels: 64 }],
        restore: (object) => {
          foliageModel(object, MODEL_FOLIAGE);
          foliageLevels(object, MODEL_FOLIAGE);
          object.traverse((node) => {
            node.castShadow = false;
            node.receiveShadow = true;
          });
        },
      });
      return [...levels, { object: new THREE.Group(), maxPixels: 1 }];
    }),
  );
}

async function grassModels(kind: Kind & { grass: ClumpShape; designs: number }, material: THREE.Material): Promise<LodLevel[][]> {
  return Promise.all(
    Array.from({ length: kind.designs }, async (_, variant) => {
      const dependencies = {
        generator: { path: "src/content/grass.ts" },
        cover: { path: "src/world/cover.ts" },
        random: { path: "src/content/random.ts" },
        shape: { value: { ...kind.grass, variant } },
      };
      let source: THREE.Mesh | undefined;
      const make = () => {
        if (source) return source;
        source = new THREE.Mesh(grassClump(variant + 1, kind.grass), material);
        source.receiveShadow = true;
        return source;
      };
      const levels = await new LodLoader().loadAsync({
        make: async () => make(),
        key: dependencies,
        material: (name) => {
          if (name !== "grass") throw new Error(`Unknown grass material ${name}`);
          return material;
        },
        levels: [{ type: "mesh", make: async () => thinned(make()), maxPixels: 512 }],
      });
      return [...levels, { object: new THREE.Group(), maxPixels: 1 }];
    }),
  );
}

/** Which ground a kind grows on, as a test on x, z. */
function where(plan: Plan, ground: Ground): (x: number, z: number) => boolean {
  const inTown = (x: number, z: number) => Math.hypot(x - TOWN.x, z - TOWN.z) < TOWN.radius + 40;
  if (ground === "forest") return (x, z) => plan.land.at(x, z) === Use.Forest;
  if (ground === "garden") return (x, z) => plan.land.at(x, z) === Use.Lawn && inTown(x, z);
  return (x, z) => plan.land.at(x, z) === Use.Lawn && !inTown(x, z);
}

/** A patch's middle level: every third blade, spread wider so the patch keeps its cover. */
function thinned(source: THREE.Object3D): THREE.Mesh {
  if (!(source instanceof THREE.Mesh)) throw new Error("a grass patch is one mesh");
  const g: THREE.BufferGeometry = source.geometry;
  const index = g.getIndex();
  if (!index) throw new Error("a grass patch is indexed");
  // each blade is 4 segments: 8 triangles, 24 indices, 10 vertices
  const kept: number[] = [];
  for (let b = 0; b * 24 < index.count; b += 3) for (let i = b * 24; i < (b + 1) * 24; i++) kept.push(index.getX(i));
  const position = g.getAttribute("position").clone();
  const blade = g.getAttribute("blade");
  for (let v = 0; v < position.count; v++) {
    const x = blade.getX(v);
    const z = blade.getY(v);
    position.setXYZ(v, x + (position.getX(v) - x) * 1.6, position.getY(v), z + (position.getZ(v) - z) * 1.6);
  }
  const thin = new THREE.BufferGeometry();
  thin.setAttribute("position", position);
  thin.setAttribute("normal", g.getAttribute("normal"));
  thin.setAttribute("blade", blade);
  thin.setIndex(kept);
  const mesh = new THREE.Mesh(thin, source.material);
  mesh.receiveShadow = true;
  return mesh;
}

/** An endless grid of tiles over the ground, each scattered with tufts where `grows`. */
class GroundTiles implements Tiles {
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();
  private readonly size = new THREE.Vector3();
  /** Tufts per tile side, on a jittered grid. */
  private readonly side: number;
  /** The most tufts of one kind a tile holds. */
  readonly perKind: number;

  constructor(
    private readonly plan: Plan,
    density: number,
    private readonly grows: (x: number, z: number) => boolean,
    private readonly scale: [number, number],
    private readonly kinds: number,
  ) {
    this.side = Math.max(1, Math.round(TILE * Math.sqrt(density)));
    this.perKind = Math.ceil((this.side * this.side) / kinds);
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
    let k = r.int(0, this.kinds - 1);
    for (let b = 0; b < n; b++)
      for (let a = 0; a < n; a++) {
        const x = i * TILE + (a + r.next()) * cell;
        const z = j * TILE + (b + r.next()) * cell;
        const angle = r.range(0, Math.PI * 2);
        const s = r.range(this.scale[0], this.scale[1]);
        k = (k + 1) % this.kinds;
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

import { HERO_VARIANT, BLOCK, plantTurn, type Plant } from "../../../public/corn/layout.ts";
import * as THREE from "three/webgpu";
import seedrandom from "seedrandom";
import type { InstancedLod } from "@drawcall/lod";
import type { NearTile, TileChunk } from "../near-tiles.ts";
import { axes, type Field, type Plan } from "../plan.ts";
import type { Terrain } from "../terrain.ts";
import type { Wall } from "../../../public/corn/block/model.ts";

/** A side of a block on its field's boundary: rows end there (`x`) or run along it (`z`), on the block's +side or, turned, its -side. */
export interface TileWall {
  wall: Wall;
  turned: boolean;
}

/** A block of a field. */
export interface Tile {
  design: number;
  /** Block frame: field axes sheared to follow the ground, centred on the ground, maybe turned half round. */
  matrix: THREE.Matrix4;
  /** Middle of the block at `top` above the ground. */
  centre: THREE.Vector3;
  field: Field;
  /** Turned half round. */
  flip: boolean;
  walls: TileWall[];
}

/** The fields cut into block tiles, each with one of `designs` designs, its frame and outer walls; `top` is the height of the tiles' centres. */
export function cut(plan: Plan, designs: number, top: number): Tile[] {
  const tiles: Tile[] = [];
  for (const [f, field] of plan.fields.entries()) {
    const { x: ax, z: az } = axes(field.angle);
    const r = seedrandom(String(100 + f));
    const across = (2 * field.halfX) / BLOCK;
    const along = (2 * field.halfZ) / BLOCK;
    for (let j = 0; j < along; j++)
      for (let i = 0; i < across; i++) {
        const lx = -field.halfX + (i + 0.5) * BLOCK;
        const lz = -field.halfZ + (j + 0.5) * BLOCK;
        const cx = field.x + ax.x * lx + az.x * lz;
        const cz = field.z + ax.y * lx + az.y * lz;
        const flip = r() < 0.5;
        const s = flip ? -1 : 1;
        const slope = plan.terrain.slope(cx, cz);
        const x = new THREE.Vector3(s * ax.x, s * (slope.x * ax.x + slope.y * ax.y), s * ax.y);
        const z = new THREE.Vector3(s * az.x, s * (slope.x * az.x + slope.y * az.y), s * az.y);
        const matrix = new THREE.Matrix4().makeBasis(x, new THREE.Vector3(0, 1, 0), z).setPosition(cx, plan.terrain.height(cx, cz), cz);
        const centre = new THREE.Vector3(0, top, 0).applyMatrix4(matrix);
        // outer sides in the field's frame (sign), seen from the block turned or not
        const walls: TileWall[] = [];
        const addWall = (wall: Wall, sign: number) => walls.push({ wall, turned: sign * s < 0 });
        if (i === 0) addWall("x", -1);
        if (i + 1 >= across) addWall("x", 1);
        if (j === 0) addWall("z", -1);
        if (j + 1 >= along) addWall("z", 1);
        tiles.push({
          design: Math.floor(designs * r()),
          matrix,
          centre,
          field,
          flip,
          walls,
        });
      }
  }
  return tiles;
}

/** Smooth 0–1 variation over a field, in patches of a few dozen metres. */
export function vigour(at: THREE.Vector3): number {
  return 0.5 + 0.25 * Math.sin(at.x / 37 + at.z / 53) + 0.25 * Math.sin(at.x / 23 - at.z / 41 + 1.7);
}

/**
 * Where the hero plant stands, whatever the layout: near the origin in the first field,
 * of the third variant, turned so that the tour finds its ladybird's leaf facing it.
 */
const HERO = { x: -0.0976, z: -0.3804, yaw: 3.5625, variant: HERO_VARIANT };

/** The hero plant's spot, and the field plant it stands in place of (the nearest): its tile, its index in the tile's design. */
export function heroSpot(
  tiles: Tile[],
  designs: Plant[][],
): {
  tile: number;
  plant: number;
  at: THREE.Vector3;
  yaw: number;
  variant: number;
} {
  let best = { tile: -1, plant: -1, distance: Infinity };
  const p = new THREE.Vector3();
  tiles.forEach((tile, t) => {
    if (Math.hypot(tile.centre.x - HERO.x, tile.centre.z - HERO.z) > BLOCK) return;
    designs[tile.design]?.forEach((plant, k) => {
      p.set(plant.x, 0, plant.z).applyMatrix4(tile.matrix);
      const distance = Math.hypot(p.x - HERO.x, p.z - HERO.z);
      if (distance < best.distance) best = { tile: t, plant: k, distance };
    });
  });
  if (best.tile < 0) throw new Error("no corn plant near the hero's spot");
  return { tile: best.tile, plant: best.plant, at: new THREE.Vector3(HERO.x, 0, HERO.z), yaw: HERO.yaw, variant: HERO.variant };
}

/** A plant's turn in the world: its own, after the field's and the block's half turn. */
function worldTurn(tile: Tile, plant: Plant, target: THREE.Quaternion): THREE.Quaternion {
  return plantTurn(plant, -tile.field.angle + (tile.flip ? Math.PI : 0), target);
}

/** The field tiles near the camera as chunks of corn plants, one InstancedLod per variant; the hero plant is left out. */
export class FieldTiles {
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(
    private readonly tiles: Tile[],
    private readonly designs: Plant[][],
    private readonly terrain: Terrain,
    private readonly hero: { tile: number; plant: number },
    /** Per plant variant, the InstancedLod drawing it. */
    private readonly lods: readonly InstancedLod[],
  ) {}

  /** The tiles whose centres lie within `reach` of `eye`, nearest first. */
  near(eye: THREE.Vector3, reach: number): NearTile[] {
    const near: NearTile[] = [];
    this.tiles.forEach((tile, t) => {
      const distance = tile.centre.distanceTo(eye);
      if (distance < reach) near.push({ tile: t, distance });
    });
    return near.sort((a, b) => a.distance - b.distance);
  }

  /** Tile `t`'s plants, a chunk per variant it has plants of. */
  chunks(t: number): TileChunk[] {
    const tile = this.tiles[t];
    if (!tile) throw new Error(`no corn tile ${t}`);
    const design = this.designs[tile.design];
    if (!design) throw new Error(`no corn design ${tile.design}`);
    const plants = design.filter((_, k) => t !== this.hero.tile || k !== this.hero.plant);
    return this.lods.flatMap((lod, variant) => {
      const mine = plants.filter((plant) => plant.variant === variant);
      if (mine.length === 0) return [];
      const instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(mine.length * 16), 16);
      mine.forEach((plant, i) => {
        this.position.set(plant.x, 0, plant.z).applyMatrix4(tile.matrix);
        this.position.y = this.terrain.height(this.position.x, this.position.z);
        worldTurn(tile, plant, this.turn);
        this.matrix.compose(this.position, this.turn, this.one).toArray(instanceMatrix.array, i * 16);
      });
      return [{ lod, parameters: { instanceMatrix } }];
    });
  }
}

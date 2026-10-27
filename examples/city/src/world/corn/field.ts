import * as THREE from "three/webgpu";
import { Random } from "../../content/random.ts";
import type { Tiles } from "../patches.ts";
import { axes, type Field, type Plan } from "../plan.ts";
import type { Terrain } from "../terrain.ts";

/** Edge of a corn block (m): 8 rows 0.75 m apart. */
export const BLOCK = 6;
export const ROWS = 8;
/** Mean distance between plants in a row (m). */
const SPACING = 0.18;
/** Which plant model each plant of a block is: one of this many. */
export const VARIANTS = 4;

/** A plant of a block design, in the block's frame: turned `yaw` about the vertical, after leaning `lean` (radians) about its own x axis. */
export interface Plant {
  variant: number;
  x: number;
  z: number;
  yaw: number;
  lean: number;
}

/** A side of a block on its field's boundary: rows end there (`x`) or run along it (`z`), on the block's +side or, turned, its -side. */
export interface Wall {
  axis: "x" | "z";
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
  walls: Wall[];
}

/**
 * One block design, sown as a planter sows: rows along x, 0.75 m apart, never quite
 * straight (each wanders a few centimetres over the block and is back on its line at the
 * block's ends, where the next block's row goes on); in the row, each plant 18 ± 6 cm
 * from the last, a few centimetres off the line, a few missing, a few doubled; every
 * plant turned any way and leaning a few degrees. No two rows keep in step, so no view,
 * least of all a bake's parallel rays, looks down long clean gaps between the plants.
 */
export function layout(seed: number): Plant[] {
  const r = new Random(seed);
  const plants: Plant[] = [];
  const sow = (x: number, z: number) =>
    plants.push({ variant: r.int(0, VARIANTS - 1), x, z: z + r.range(-0.04, 0.04), yaw: r.range(0, 2 * Math.PI), lean: r.range(-0.07, 0.07) });
  for (let row = 0; row < ROWS; row++) {
    const line = -BLOCK / 2 + (row + 0.5) * (BLOCK / ROWS);
    const bends = [r.range(-0.04, 0.04), r.range(-0.02, 0.02), r.range(-0.012, 0.012)];
    const wander = (x: number) => bends.reduce((sum, a, k) => sum + a * Math.sin(((k + 1) * Math.PI * (x + BLOCK / 2)) / BLOCK), 0);
    for (let x = -BLOCK / 2 + r.range(0, SPACING); x < BLOCK / 2; x += SPACING * r.range(0.65, 1.35)) {
      if (r.chance(0.04)) continue;
      sow(x, line + wander(x));
      if (r.chance(0.03)) sow(x + r.range(0.04, 0.07), line + wander(x));
    }
  }
  return plants;
}

/** The turn of a plant standing `plant`, after the frame's own turn `yaw`. */
export function plantTurn(plant: Plant, yaw: number, target: THREE.Quaternion): THREE.Quaternion {
  return target.setFromEuler(euler.set(plant.lean, plant.yaw + yaw, 0, "YXZ"));
}

const euler = new THREE.Euler();

/** The fields cut into block tiles, each with one of `designs` designs, its frame and outer walls; `top` is the height of the tiles' centres. */
export function cut(plan: Plan, designs: number, top: number): Tile[] {
  const tiles: Tile[] = [];
  for (const [f, field] of plan.fields.entries()) {
    const { x: ax, z: az } = axes(field.angle);
    const r = new Random(100 + f);
    const across = (2 * field.halfX) / BLOCK;
    const along = (2 * field.halfZ) / BLOCK;
    for (let j = 0; j < along; j++)
      for (let i = 0; i < across; i++) {
        const lx = -field.halfX + (i + 0.5) * BLOCK;
        const lz = -field.halfZ + (j + 0.5) * BLOCK;
        const cx = field.x + ax.x * lx + az.x * lz;
        const cz = field.z + ax.y * lx + az.y * lz;
        const flip = r.chance(0.5);
        const s = flip ? -1 : 1;
        const slope = plan.terrain.slope(cx, cz);
        const x = new THREE.Vector3(s * ax.x, s * (slope.x * ax.x + slope.y * ax.y), s * ax.y);
        const z = new THREE.Vector3(s * az.x, s * (slope.x * az.x + slope.y * az.y), s * az.y);
        const matrix = new THREE.Matrix4().makeBasis(x, new THREE.Vector3(0, 1, 0), z).setPosition(cx, plan.terrain.height(cx, cz), cz);
        const centre = new THREE.Vector3(0, top, 0).applyMatrix4(matrix);
        // outer sides in the field's frame (sign), seen from the block turned or not
        const walls: Wall[] = [];
        const wall = (axis: "x" | "z", sign: number) => walls.push({ axis, turned: sign * s < 0 });
        if (i === 0) wall("x", -1);
        if (i + 1 >= across) wall("x", 1);
        if (j === 0) wall("z", -1);
        if (j + 1 >= along) wall("z", 1);
        tiles.push({
          design: r.int(0, designs - 1),
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
const HERO = { x: -0.0976, z: -0.3804, yaw: 3.5625, variant: 2 };

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

/** The field tiles as patches of corn plants, one InstancedLod per variant; the hero plant is left out. */
export class FieldTiles implements Tiles {
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(
    private readonly tiles: Tile[],
    private readonly designs: Plant[][],
    private readonly terrain: Terrain,
    private readonly hero: { tile: number; plant: number },
  ) {}

  near(eye: THREE.Vector3, reach: number, visit: (tile: number, distance: number) => void): void {
    for (let t = 0; t < this.tiles.length; t++) {
      const tile = this.tiles[t];
      if (!tile) throw new Error(`no corn tile ${t}`);
      const dx = tile.centre.x - eye.x;
      const dy = tile.centre.y - eye.y;
      const dz = tile.centre.z - eye.z;
      // Keep the arithmetic in this loop to avoid boxing helper return values.
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance < reach) visit(t, distance);
    }
  }

  fill(t: number, emit: (lod: number, matrix: THREE.Matrix4) => void): void {
    const tile = this.tiles[t];
    if (!tile) throw new Error(`no corn tile ${t}`);
    this.designs[tile.design]?.forEach((plant, k) => {
      if (t === this.hero.tile && k === this.hero.plant) return;
      this.position.set(plant.x, 0, plant.z).applyMatrix4(tile.matrix);
      this.position.y = this.terrain.height(this.position.x, this.position.z);
      worldTurn(tile, plant, this.turn);
      emit(plant.variant, this.matrix.compose(this.position, this.turn, this.one));
    });
  }
}

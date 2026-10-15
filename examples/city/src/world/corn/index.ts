import * as THREE from "three";
import { ImpostorMesh, type InstancedLod, Lod } from "@drawcall/lod";
import { cornPlant } from "../../content/corn/index.ts";
import { step } from "../../loading.ts";
import { heroPlant } from "../hero.ts";
import { culled, diameter, impostor, instanced } from "../levels.ts";
import { Patches } from "../patches.ts";
import type { Plan } from "../plan.ts";
import { bakeCovers, type Cover, type Skirt, TOP } from "./covers.ts";
import { BLOCK, cut, FieldTiles, heroSpot, layout, VARIANTS } from "./field.ts";

const DESIGNS = 4;
/** Blocks that can hold plants at once. */
const CHUNKS = 128;
/**
 * Plants switch from the model to their impostor at this height, sooner than the
 * impostor's own sharpness would allow (about 120 px), for the frame budget: a field holds
 * a few hundred plants within five metres and thousands within ten. The field's plants
 * are tessellated for that range; only the hero plant has leaves fine enough for millimetres.
 */
const PLANT_PIXELS = 1000;
/**
 * Height at which every plant starts to dither out, wherever it stands: about 11.5 m away
 * on an 800 px tall view. Beyond, the baked covers carry the field.
 */
const PLANT_GONE = 215;
/**
 * The covers rise out of the soil over this many metres, ending this far in front of
 * where the plants start to dither out.
 */
const RAMP = 2;
const LEAD = 0.5;
/** A block's canopy is drawn flat below this height on screen (about 120 m away on an 800 px tall view). */
const FLAT_PIXELS = 60;
const FIELD_LEAVES: [number, number] = [24, 4];
/** Farthest a plant's bounding-sphere centre is from its block's centre. */
const BLOCK_RADIUS = Math.hypot(BLOCK / 2, TOP - 1.2, BLOCK / 2);

/**
 * Corn fields: millions of plants, built on top of the package. A field is cut into 6 m
 * blocks of a few shared designs. Near the camera the blocks hold their real plants:
 * they are lent instance slots in per-variant InstancedLods (plant, impostor, nothing) —
 * see `Patches` — and each plant switches by its own height on screen, so the plants end
 * in a round, dithered band around the camera. Behind it the blocks draw their plants
 * baked onto a ridged canopy at the leaves' tops, and the fields' boundary blocks onto
 * walls on their outer sides. These covers rise out of the soil just in front of the
 * band, so the plants dither out over a closed canopy. One plant near the origin is the
 * hero: a separate `Lod` with finer leaves, carrying the ladybird.
 */
export class Corn extends THREE.Object3D {
  readonly isLOD = true;
  autoUpdate = true;
  readonly covers: Cover[];
  readonly plants: Patches;
  readonly hero: Lod;
  readonly ladybird: Lod;
  private readonly skirt: Skirt;
  /** The plants' bounding diameter. */
  private readonly plantSize: number;
  /** How much nearer than set the plants dither out, while there are too few plant slots. */
  private squeeze = 1;
  /** Distance at which plants start to dither out, as of the last update. */
  private fadeFrom = 0;

  private constructor(parts: { covers: Cover[]; skirt: Skirt; plants: InstancedLod[]; tiles: FieldTiles; plantSize: number; hero: Lod; ladybird: Lod }) {
    super();
    this.covers = parts.covers;
    this.skirt = parts.skirt;
    const perTile = parts.plants.map((lod) => lod.count / CHUNKS);
    this.plants = new Patches(parts.plants, perTile, CHUNKS, parts.tiles, () => this.fadeFrom / (1 - Lod.fade) + BLOCK_RADIUS);
    this.plantSize = parts.plantSize;
    this.hero = parts.hero;
    this.ladybird = parts.ladybird;
    // updated here, with the reach this sets
    this.plants.autoUpdate = false;
    this.add(this.plants, ...this.covers.map((c) => c.lod), this.hero, this.ladybird);
  }

  static async build(plan: Plan): Promise<Corn> {
    const seeds = Array.from({ length: VARIANTS }, (_, v) => v + 1);
    const sources = seeds.map((seed) => cornPlant(seed, { leafSegments: FIELD_LEAVES, detail: "field" }));
    const levels = await step("corn plants", () =>
      Promise.all(
        sources.map(async (source) => {
          // twice the default resolution keeps the impostor sharp from where the plant hands over
          const far = await impostor(source, {
            maxPixels: PLANT_PIXELS,
            resolution: 256,
            frames: 8,
            draw: { parallax: 0 },
          });
          // tens of thousands of impostors overlapping in the shadow map cost a third of
          // the frame; beyond a few metres the canopy hides the soil they would shade
          far.object.castShadow = false;
          return [far, culled(PLANT_GONE)];
        }),
      ),
    );
    const designs = Array.from({ length: DESIGNS }, (_, d) => layout(d + 11));
    const tiles = cut(plan, DESIGNS, TOP);
    const hero = heroSpot(tiles, designs);
    const skirt = { value: new THREE.Vector2() };
    const bare = seeds.map((seed) => cornPlant(seed, { leafSegments: FIELD_LEAVES, detail: "field", tassel: false }));
    const covers = await step("corn blocks", () => bakeCovers(designs, { tasselled: sources, bare }, tiles, skirt));
    const perTile = seeds.map((_, v) => Math.max(...designs.map((plants) => plants.filter((p) => p.variant === v).length)));
    const own = levels[hero.variant]?.[0];
    const far = own?.object;
    if (!own || !(far instanceof ImpostorMesh)) throw new Error("the hero's variant has no impostor level");
    return new Corn({
      covers,
      skirt,
      plants: sources.map((source, v) => instanced(`corn plant ${v + 1}`, source, levels[v] ?? [], CHUNKS * (perTile[v] ?? 0))),
      tiles: new FieldTiles(tiles, designs, plan.terrain, hero),
      plantSize: Math.max(...sources.map(diameter)),
      ...heroPlant({ ...hero, seed: seeds[hero.variant] ?? 1 }, { object: far, maxPixels: own.maxPixels }, plan.terrain),
    });
  }

  /**
   * Called by three's renderer while it lists the scene, before the plants and covers
   * sort. Plants dither out at one height on screen; covers rise out of the soil in
   * front of that, are drawn wherever a part of them may have risen, and swap to their
   * ridged level once no part of them is rising. When more blocks are in reach than there
   * are plant slots, the plants dither out nearer, and back out as slots free up.
   */
  update(camera: THREE.Camera): void {
    const scale = ((camera.projectionMatrix.elements[5] ?? 1) * Patches.height * Lod.quality) / 2;
    const gone = Math.min(PLANT_GONE * this.squeeze, PLANT_PIXELS * 0.85);
    this.fadeFrom = (this.plantSize * scale) / gone;
    this.plants.update(camera);
    const over = this.plants.wanted / CHUNKS;
    this.squeeze = over > 1 ? Math.min(this.squeeze * Math.max(1.02, Math.sqrt(over)), 4) : Math.max(1, this.squeeze / 1.02);
    for (const lod of [...this.plants.lods, this.hero]) {
      const empty = lod.levels[2];
      if (!empty) throw new Error(`${lod.name} has no empty level`);
      empty.maxPixels = gone;
    }
    const risen = Math.max(this.fadeFrom - LEAD, RAMP);
    this.skirt.value.set(risen - RAMP, risen);
    for (const { lod, diameter } of this.covers) {
      const [, near, ridged, flat] = lod.levels;
      if (!near) throw new Error(`${lod.name} has no baked level`);
      // the measure is the distance to the cover's centre; a part of it is up to its radius nearer or farther
      near.maxPixels = (diameter * scale) / ((1 - Lod.fade) * Math.max(risen - RAMP - diameter / 2, 0.5));
      if (!ridged || !flat) continue;
      ridged.maxPixels = Math.min((diameter * scale) / (risen + diameter / 2), near.maxPixels * (1 - Lod.fade));
      flat.maxPixels = Math.min(FLAT_PIXELS, ridged.maxPixels * (1 - Lod.fade));
    }
  }
}

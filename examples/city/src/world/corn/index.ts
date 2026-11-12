import * as THREE from "three/webgpu";
import type { GLTSScene } from "@drawcall/glts";
import { Lod, type Wind } from "@drawcall/lod";
import { sharing } from "../../loading.ts";
import { heroPlant } from "./hero.ts";
import { reach, sourceBox } from "../bounds.ts";
import { NearTiles } from "../near-tiles.ts";
import { lodOf, Scatter } from "../scatter.ts";
import { screenScale } from "../screen.ts";
import type { Plan } from "../plan.ts";
import { blocks, type Block, skirt } from "./blocks.ts";
import { cut, FieldTiles, heroSpot } from "./field.ts";
import { cutoff, setCutoff } from "./levels.ts";
import { BLOCK, DESIGNS, layout, VARIANTS } from "../../../public/corn/layout.ts";
import { TOP } from "../../../public/corn/block/shapes.ts";

/** Field blocks whose plants are drawn at once. */
const ROOM = 128;
const RAMP = 2;
const LEAD = 0.5;
const FLAT_PIXELS = 60;
const BLOCK_RADIUS = Math.hypot(BLOCK / 2, TOP - 1.2, BLOCK / 2);

const eye = new THREE.Vector3();

/**
 * The corn fields: their blocks everywhere, the plants of the blocks near the camera, and the hero plant with its
 * ladybird. The blocks share `skirt` with their assets, which rise out of the soil by it.
 */
export class Corn extends THREE.Object3D {
  private squeeze = 1;
  private fadeFrom = 0;
  /** The plants' Lods and the hero's, which plants dither out of together. */
  private readonly cut: readonly Lod[];
  private constructor(
    readonly blocks: Block[],
    readonly plants: NearTiles,
    /** Each plant variant's Lod, which the field's plants of it draw with. */
    readonly plantLods: readonly Lod[],
    readonly hero: GLTSScene,
    readonly ladybird: GLTSScene,
    readonly anchors: { hero: THREE.Vector3; ladybird: THREE.Vector3 },
    private readonly plantSize: number,
    scatter: Scatter,
  ) {
    super();
    this.cut = [...plantLods, lodOf(hero)];
    this.add(scatter, plants, hero, ladybird);
  }

  static async build(plan: Plan): Promise<Corn> {
    const designs = Array.from({ length: DESIGNS }, (_, d) => layout(d));
    const tiles = cut(plan, DESIGNS, TOP);
    const spot = heroSpot(tiles, designs);
    const scatter = new Scatter(sharing({ "/corn/block/skirt.ts": { skirt: () => skirt } }));
    const plants = Array.from({ length: VARIANTS }, async (_, variant) => {
      const url = `/corn/index.glts?variant=${variant}`;
      // Room for a slot per tile held, each with as many of this variant's plants as a block design has most.
      const perTile = Math.max(...designs.map((plants) => plants.filter((plant) => plant.variant === variant).length));
      const [lod, range] = await Promise.all([scatter.lod(url), scatter.take(url, ROOM * perTile, false)]);
      const box = sourceBox(lod.levels);
      return { lod, size: box.getSize(new THREE.Vector3()).length(), variant: { range, perTile, reach: reach(lod.levels) } };
    });
    const [baked, variants, details] = await Promise.all([blocks(tiles, scatter), Promise.all(plants), heroPlant(spot, plan.terrain)]);
    await scatter.seal();
    const field = new FieldTiles(
      tiles,
      designs,
      plan.terrain,
      spot,
      variants.map(({ variant }) => variant),
    );
    let corn: Corn | undefined;
    // One block filled a frame: the CPU writes its plants.
    const near = new NearTiles({
      near: (position) => {
        if (!corn) throw new Error("Corn tiles requested before initialization");
        return field.near(position, corn.fadeFrom / (1 - Lod.fade) + BLOCK_RADIUS);
      },
      fill: (tile, slot) => field.fill(tile, slot),
      perFrame: 1,
      room: ROOM,
    });
    corn = new Corn(
      baked,
      near,
      variants.map(({ lod }) => lod),
      details.hero,
      details.ladybird,
      details.anchors,
      Math.max(...variants.map(({ size }) => size)),
      scatter,
    );
    return corn;
  }

  applyWind(wind: Wind): void {
    for (const lod of this.plantLods) {
      const box = sourceBox(lod.levels);
      wind.apply(lod, { amplitude: (box.max.y - box.min.y) * 0.04 });
    }
  }

  /**
   * Before rendering, on a screen `height` CSS pixels tall: plants dither out at one height on screen; blocks rise out of the soil in
   * front of that, are drawn wherever a part of them may have risen, and swap to their
   * ridged level once no part of them is rising. When more blocks are in reach than there
   * are plant slots, the plants dither out nearer, and back out as slots free up.
   */
  update(camera: THREE.Camera, height: number): void {
    const scale = screenScale(camera, height, Lod.quality);
    const gone = cutoff(this.squeeze);
    this.fadeFrom = (this.plantSize * scale) / gone;
    this.plants.update(eye.setFromMatrixPosition(camera.matrixWorld));
    const over = this.plants.wanted / ROOM;
    this.squeeze = over > 1 ? Math.min(this.squeeze * Math.max(1.02, Math.sqrt(over)), 4) : Math.max(1, this.squeeze / 1.02);
    for (const lod of this.cut) setCutoff(lod.levels, gone);
    const risen = Math.max(this.fadeFrom - LEAD, RAMP);
    skirt.value.set(risen - RAMP, risen);
    for (const { kind, lod, diameter } of this.blocks) {
      const [, rising, ridged, flat] = lod.levels;
      if (!rising) throw new Error(`${lod.name} has no rising level`);
      // the measure is the distance to the block's centre; a part of it is up to its radius nearer or farther
      rising.maxPixels = (diameter * scale) / ((1 - Lod.fade) * Math.max(risen - RAMP - diameter / 2, 0.5));
      if (kind === "wall") continue;
      if (!ridged || !flat) throw new Error(`${lod.name} needs ridged and flat levels`);
      ridged.maxPixels = Math.min((diameter * scale) / (risen + diameter / 2), rising.maxPixels * (1 - Lod.fade));
      flat.maxPixels = Math.min(FLAT_PIXELS, ridged.maxPixels * (1 - Lod.fade));
    }
  }
}

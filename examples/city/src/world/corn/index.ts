import * as THREE from "three/webgpu";
import { InstancedLod, LazyLevel, Lod, LodLoader, type Wind } from "@drawcall/lod";
import { cornPlant } from "../../content/corn/index.ts";
import { step } from "../../loading.ts";
import { heroPlant } from "../hero.ts";
import { proceduralFiles } from "../cache.ts";
import { sourceBox } from "../bounds.ts";
import { Patches } from "../patches.ts";
import type { Plan } from "../plan.ts";
import { bakeCovers, coverLevels, type Cover, type Skirt, skirt as skirtUniform, TOP } from "./covers.ts";
import { BLOCK, cut, FieldTiles, heroSpot, layout, VARIANTS } from "./field.ts";
import { prepare, material, foliage } from "./materials.ts";
import { cutoff, setCutoff, PLANT_PIXELS, FAR_PIXELS, PLANT_GONE } from "./levels.ts";

const DESIGNS = 4;
const CHUNKS = 128;
const RAMP = 2;
const LEAD = 0.5;
const FLAT_PIXELS = 60;
const FIELD_LEAVES: [number, number] = [24, 4];
const BLOCK_RADIUS = Math.hypot(BLOCK / 2, TOP - 1.2, BLOCK / 2);

/** Every field system exists at startup; the package independently requests each plant level. */
export class Corn extends THREE.Object3D {
  private squeeze = 1;
  private fadeFrom = 0;
  private readonly active: readonly (InstancedLod | Lod)[];
  private constructor(
    readonly covers: Cover[],
    private readonly skirt: Skirt,
    readonly plants: Patches,
    readonly hero: Lod,
    readonly ladybird: Lod,
    readonly anchors: { hero: THREE.Vector3; ladybird: THREE.Vector3 },
    private readonly plantSize: number,
  ) {
    super();
    this.active = [...plants.lods, hero];
    this.add(plants, ...covers.map((cover) => cover.lod), hero, ladybird);
  }

  static async build(plan: Plan): Promise<Corn> {
    const designs = Array.from({ length: DESIGNS }, (_, d) => layout(d + 11));
    const tiles = cut(plan, DESIGNS, TOP);
    const spot = heroSpot(tiles, designs);
    const key = {
      ...proceduralFiles("src/world/corn/index.ts", { designs: DESIGNS, leafSegments: FIELD_LEAVES, variants: VARIANTS }, []),
      covers: { path: "src/world/corn/covers.ts" },
      field: { path: "src/world/corn/field.ts" },
      materials: { path: "src/world/corn/materials.ts" },
      cutoff: { path: "src/world/corn/levels.ts" },
    };
    const loader = new LodLoader();
    let baking: Promise<THREE.Mesh[]> | undefined;
    const bake = () =>
      (baking ??= (async () => {
        await prepare();
        const tasselled = Array.from({ length: VARIANTS }, (_, v) => cornPlant(v + 1, { leafSegments: FIELD_LEAVES, detail: "field" }));
        const bare = Array.from({ length: VARIANTS }, (_, v) => cornPlant(v + 1, { leafSegments: FIELD_LEAVES, detail: "field", tassel: false }));
        const bakes = await step("corn blocks", () => bakeCovers(designs, { tasselled, bare }));
        for (const object of [...tasselled, ...bare])
          object.traverse((node) => {
            if (node instanceof THREE.Mesh) node.geometry.dispose();
          });
        return bakes;
      })());
    const bakes = await Promise.all(
      Array.from({ length: DESIGNS + 2 }, async (_, index) => {
        const levels = await loader.loadLevelsAsync({
          type: "baked",
          source: async () => {
            const cover = (await bake())[index];
            if (!cover) throw new Error(`Missing corn cover ${index}`);
            return cover;
          },
          key: { ...key, cover: { value: index } },
          levels: [],
        });
        const source = levels[0]?.object;
        const mesh = source instanceof LazyLevel ? await source.load() : source;
        if (!(mesh instanceof THREE.Mesh)) throw new Error(`Corn cover ${index} is not a mesh`);
        return mesh;
      }),
    );
    const skirt = skirtUniform();
    const covers = coverLevels(bakes, tiles, skirt);
    const perTile = Array.from({ length: VARIANTS }, (_, variant) =>
      Math.max(...designs.map((design) => design.filter((plant) => plant.variant === variant).length)),
    );
    const lods: InstancedLod[] = [];
    const sizes: number[] = [];
    for (let variant = 0; variant < VARIANTS; variant++) {
      const count = perTile[variant];
      if (count === undefined) throw new Error("Missing corn variant tile capacity");
      const levels = await loader.loadAsync({
        source: async () => {
          await prepare();
          return cornPlant(variant + 1, { leafSegments: FIELD_LEAVES, detail: "field" });
        },
        material,
        key: { ...key, variant: { value: variant } },
        levels: [
          { type: "impostor", layout: "hemi", maxPixels: PLANT_PIXELS, resolution: 256, frames: 8, draw: { parallax: 0 } },
          { type: "impostor", layout: "hemi", maxPixels: FAR_PIXELS, resolution: 64, frames: 8, draw: { parallax: 0 } },
          { type: "empty", maxPixels: PLANT_GONE },
        ],
        restore: (object, index) => {
          foliage(object);
          if (index === 1 || index === 2) object.castShadow = false;
        },
      });
      const lod = new InstancedLod(levels, CHUNKS * count);
      lod.name = `corn plant ${variant + 1}`;
      const box = sourceBox(lod);
      sizes.push(box.getSize(new THREE.Vector3()).length());
      lods.push(lod);
    }
    const crop = lods[spot.variant];
    const detailed = crop?.levels[1],
      coarse = crop?.levels[2];
    if (!detailed || !coarse) throw new Error("The hero's variant has no impostor levels");
    const details = await heroPlant({ ...spot, seed: spot.variant + 1 }, [detailed, coarse], plan.terrain);
    let corn: Corn | undefined;
    const patches = new Patches(lods, perTile, CHUNKS, new FieldTiles(tiles, designs, plan.terrain, spot), () => {
      if (!corn) throw new Error("Corn tiles requested before initialization");
      return corn.fadeFrom / (1 - Lod.fade) + BLOCK_RADIUS;
    });
    corn = new Corn(covers, skirt, patches, details.hero, details.ladybird, details.anchors, Math.max(...sizes));
    return corn;
  }

  applyWind(wind: Wind): void {
    for (const lod of this.plants.lods) {
      const box = sourceBox(lod);
      wind.apply(lod, { amplitude: (box.max.y - box.min.y) * 0.04 });
    }
  }

  /**
   * Before rendering, plants dither out at one height on screen; covers rise out of the soil in
   * front of that, are drawn wherever a part of them may have risen, and swap to their
   * ridged level once no part of them is rising. When more blocks are in reach than there
   * are plant slots, the plants dither out nearer, and back out as slots free up.
   */
  update(camera: THREE.Camera): void {
    const scale = ((camera.projectionMatrix.elements[5] ?? 1) * Patches.height * Lod.quality) / 2;
    const gone = cutoff(this.squeeze);
    this.fadeFrom = (this.plantSize * scale) / gone;
    this.plants.update(camera);
    const over = this.plants.wanted / CHUNKS;
    this.squeeze = over > 1 ? Math.min(this.squeeze * Math.max(1.02, Math.sqrt(over)), 4) : Math.max(1, this.squeeze / 1.02);
    for (const lod of this.active) setCutoff(lod.levels, gone);
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

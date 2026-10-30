import * as THREE from "three/webgpu";
import { InstancedLod, Lod, type Wind } from "@drawcall/lod";
import { loader, scripts } from "../../loading.ts";
import { heroPlant } from "./hero.ts";
import { sourceBox } from "../bounds.ts";
import { Patches } from "../patches.ts";
import type { Plan } from "../plan.ts";
import { covers, type Cover, type Skirt, skirt as skirtUniform } from "./covers.ts";
import { cut, FieldTiles, heroSpot } from "./field.ts";
import { cutoff, plantRequest, setCutoff } from "./levels.ts";
import { BLOCK, DESIGNS, layout, VARIANTS } from "../../../public/content/corn/layout.ts";
import { TOP } from "../../../public/content/corn/cover/shapes.ts";

const CHUNKS = 128;
const RAMP = 2;
const LEAD = 0.5;
const FLAT_PIXELS = 60;
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
    const designs = Array.from({ length: DESIGNS }, (_, d) => layout(d));
    const tiles = cut(plan, DESIGNS, TOP);
    const spot = heroSpot(tiles, designs);
    // Covers have no drawable source as their finest level: plants show through the empty level.
    const [canopies, x, z] = await Promise.all([
      Promise.all(Array.from({ length: DESIGNS }, (_, design) => coverBake(`design=${design}`))),
      coverBake("axis=x"),
      coverBake("axis=z"),
    ]);
    const skirt = skirtUniform();
    const perTile = Array.from({ length: VARIANTS }, (_, variant) =>
      Math.max(...designs.map((design) => design.filter((plant) => plant.variant === variant).length)),
    );
    const plants = await Promise.all(
      Array.from({ length: VARIANTS }, async (_, variant) => {
        const count = perTile[variant];
        if (count === undefined) throw new Error("Missing corn variant tile capacity");
        const levels = await loader.loadAsync(plantRequest(`/corn/plant.glts?variant=${variant}`));
        const lod = new InstancedLod(levels, CHUNKS * count);
        lod.name = `corn plant ${variant}`;
        const box = sourceBox(lod.levels);
        return { lod, size: box.getSize(new THREE.Vector3()).length() };
      }),
    );
    const details = await heroPlant(spot, plan.terrain);
    let corn: Corn | undefined;
    const patches = new Patches(
      plants.map(({ lod }) => lod),
      perTile,
      CHUNKS,
      new FieldTiles(tiles, designs, plan.terrain, spot),
      () => {
        if (!corn) throw new Error("Corn tiles requested before initialization");
        return corn.fadeFrom / (1 - Lod.fade) + BLOCK_RADIUS;
      },
    );
    corn = new Corn(
      covers({ canopies, walls: { x, z } }, tiles, skirt),
      skirt,
      patches,
      details.hero,
      details.ladybird,
      details.anchors,
      Math.max(...plants.map(({ size }) => size)),
    );
    return corn;
  }

  applyWind(wind: Wind): void {
    for (const lod of this.plants.lods) {
      const box = sourceBox(lod.levels);
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
    const scale = (camera.projectionMatrix.elements[5] * Patches.height * Lod.quality) / 2;
    const gone = cutoff(this.squeeze);
    this.fadeFrom = (this.plantSize * scale) / gone;
    this.plants.update(camera);
    const over = this.plants.wanted / CHUNKS;
    this.squeeze = over > 1 ? Math.min(this.squeeze * Math.max(1.02, Math.sqrt(over)), 4) : Math.max(1, this.squeeze / 1.02);
    for (const lod of this.active) setCutoff(lod.levels, gone);
    const risen = Math.max(this.fadeFrom - LEAD, RAMP);
    this.skirt.value.set(risen - RAMP, risen);
    for (const { kind, lod, diameter } of this.covers) {
      const [, rising, ridged, flat] = lod.levels;
      if (!rising) throw new Error(`${lod.name} has no baked level`);
      // the measure is the distance to the cover's centre; a part of it is up to its radius nearer or farther
      rising.maxPixels = (diameter * scale) / ((1 - Lod.fade) * Math.max(risen - RAMP - diameter / 2, 0.5));
      if (kind === "wall") continue;
      if (!ridged || !flat) throw new Error(`${lod.name} needs ridged and flat levels`);
      ridged.maxPixels = Math.min((diameter * scale) / (risen + diameter / 2), rising.maxPixels * (1 - Lod.fade));
      flat.maxPixels = Math.min(FLAT_PIXELS, ridged.maxPixels * (1 - Lod.fade));
    }
  }
}

/** A cover's raw bake, `query` selecting it; the scene's resources pass to the returned mesh. */
async function coverBake(query: string): Promise<THREE.Mesh> {
  const scene = await scripts.loadAsync(`/corn/cover.glts?${query}`);
  try {
    const mesh = scene.children[0];
    if (!(mesh instanceof THREE.Mesh)) throw new Error(`Corn cover ${query} is not a mesh`);
    // Transfer the bake's resources to the cover levels before releasing its script execution.
    scene.remove(mesh);
    return mesh;
  } finally {
    scene.dispose();
  }
}

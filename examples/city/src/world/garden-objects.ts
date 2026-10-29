import * as THREE from "three/webgpu";
import { InstancedLod, LodLoader } from "@drawcall/lod";
import { Random } from "../content/random.ts";
import { hedge } from "../content/hedge.ts";
import { greenhouse, letterbox, patioSet, shed, swing, washingLine } from "../content/garden.ts";
import { texturesReady, restoreSurface } from "../content/materials.ts";
import { place } from "./place.ts";
import { HEDGE } from "./gardens.ts";
import type { Plan } from "./plan.ts";
import { proceduralFiles } from "./cache.ts";
import { object } from "./objects.ts";

export async function gardenObjects(plan: Plan): Promise<InstancedLod[]> {
  return (await Promise.all([gardenThings(plan), hedges(plan)])).flat();
}

const models: Record<string, { make: () => THREE.Object3D; textures: string[] }> = {
  shed: { make: () => shed("#d9d4c8"), textures: ["white_planks_clean", "corrugated_iron", "brushed_concrete_04", "distressed_painted_planks"] },
  letterbox: { make: letterbox, textures: ["wood_table_001"] },
  greenhouse: { make: greenhouse, textures: ["red_brick"] },
  swing: { make: swing, textures: ["wood_table_001"] },
  "washing line": { make: washingLine, textures: [] },
  "patio set": { make: patioSet, textures: [] },
};

async function gardenThings(plan: Plan): Promise<InstancedLod[]> {
  const paints = ["#ffffff", "#9fb0a0", "#b9a58c", "#8c9aa8", "#c9b9a0"];
  return Promise.all(
    [...plan.garden].map(async ([name, spots]) => {
      const model = models[name];
      if (!model) throw new Error(`no garden model "${name}"`);
      const loaded = await object(proceduralFiles("src/content/garden.ts", { name, color: "#d9d4c8" }, model.textures), model.make, 3);
      const lod = new InstancedLod(loaded, spots.length);
      lod.name = name;
      const r = new Random(name.length);
      const color = new THREE.Color();
      spots.forEach((at, i) => {
        place(lod, i, at);
        if (name === "shed") lod.setColorAt(i, color.set(r.pick(paints)));
      });
      return lod;
    }),
  );
}

/** Fine lumps, then the same clipped outline without lumps, then a culled level. */
async function hedges(plan: Plan): Promise<InstancedLod[]> {
  return Promise.all(
    [1, 2, 3].map(async (seed, d) => {
      const make = async (detail: "fine" | "box") => {
        const mesh = hedge(HEDGE, seed, detail);
        await texturesReady(mesh);
        return mesh;
      };
      const mine = plan.hedges.filter((_, i) => i % 3 === d);
      const levels = await new LodLoader().loadAsync({
        make: () => make("fine"),
        key: proceduralFiles("src/world/garden-objects.ts", { length: HEDGE, seed }, ["leafy_grass"]),
        material: restoreSurface,
        restore: texturesReady,
        levels: [{ type: "mesh", make: () => make("box"), maxPixels: 120 }],
      });
      levels.push({ object: new THREE.Group(), maxPixels: 3 });
      const lod = new InstancedLod(levels, mine.length);
      lod.name = `hedges ${seed}`;
      const r = new Random(d + 7);
      const color = new THREE.Color();
      mine.forEach((at, i) => {
        place(lod, i, at);
        lod.setColorAt(i, color.setRGB(1, 1, 1).multiplyScalar(r.range(0.85, 1.1)));
      });
      return lod;
    }),
  );
}

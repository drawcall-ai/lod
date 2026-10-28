import * as THREE from "three/webgpu";
import type { InstancedLod } from "@drawcall/lod";
import { Random } from "../content/random.ts";
import { hedge } from "../content/hedge.ts";
import { greenhouse, letterbox, patioSet, shed, swing, washingLine } from "../content/garden.ts";
import { culled, instanced, place } from "./levels.ts";
import { HEDGE } from "./gardens.ts";
import type { Plan } from "./plan.ts";

/** Small garden props and clipped hedges, in their original placement and colour order. */
export function gardenObjects(plan: Plan): InstancedLod[] {
  return [...gardenThings(plan), ...hedges(plan)];
}

/** Garden things, each the model up close and nothing below a few pixels; sheds come in a few paints. */
function gardenThings(plan: Plan): InstancedLod[] {
  const models: Record<string, () => THREE.Object3D> = {
    shed: () => shed("#d9d4c8"),
    letterbox,
    greenhouse,
    swing,
    "washing line": washingLine,
    "patio set": patioSet,
  };
  const paints = ["#ffffff", "#9fb0a0", "#b9a58c", "#8c9aa8", "#c9b9a0"];
  return [...plan.garden].map(([name, spots]) => {
    const make = models[name];
    if (!make) throw new Error(`no garden model "${name}"`);
    const lod = instanced(name, make(), [culled(3)], spots.length);
    const r = new Random(name.length);
    const color = new THREE.Color();
    spots.forEach((at, i) => {
      place(lod, i, at);
      if (name === "shed") lod.setColorAt(i, color.set(r.pick(paints)));
    });
    return lod;
  });
}

/** Clipped garden hedges: a few sections of different lumps, a box further out, nothing below a few pixels. */
function hedges(plan: Plan): InstancedLod[] {
  const designs = [1, 2, 3].map((seed) => [hedge(HEDGE, seed), hedge(HEDGE, seed, "box")] as const);
  return designs.map(([source, box], d) => {
    const mine = plan.hedges.filter((_, i) => i % designs.length === d);
    // the lumps show only up close: a plain box from where the hedge is under ~120 px
    const lod = instanced(`hedges ${d + 1}`, source, [{ object: box, maxPixels: 120 }, culled(3)], mine.length);
    const r = new Random(d + 7);
    const color = new THREE.Color();
    mine.forEach((at, i) => {
      place(lod, i, at);
      lod.setColorAt(i, color.setRGB(1, 1, 1).multiplyScalar(r.range(0.85, 1.1)));
    });
    return lod;
  });
}

import * as THREE from "three/webgpu";
import seedrandom from "seedrandom";
import { scripts } from "../loading.ts";
import { copiesAt, Scatter } from "./scatter.ts";
import type { Plan } from "./plan.ts";

/** Street furniture and cars, as Market assets in public/, by the plan's model id. */
const MODELS: Record<string, string> = {
  street_lamp_01: "/street-lamp/index.glts",
  painted_wooden_bench: "/painted-wooden-bench/index.glts",
  metal_trash_can: "/metal-trash-can/index.glts",
  fire_hydrant: "/fire-hydrant/index.glts",
  utility_box_01: "/utility-box/index.glts",
  covered_car: "/covered-car/index.glts",
  wooden_crate_01: "/wooden-crate/index.glts",
  planter_box_01: "/planter-box/index.glts",
};

/** The hedge designs, which the gardens' hedge sections take turns with. */
const HEDGES = ["/clipped-hedge/index.glts?variant=0", "/clipped-hedge/index.glts?variant=1", "/clipped-hedge/index.glts?variant=2"];

/** Sheds come in a few paints. */
const PAINTS = ["#ffffff", "#9fb0a0", "#b9a58c", "#8c9aa8", "#c9b9a0"];

/** Street furniture, cars, fences, street signs, hedges and garden fixtures where the plan put them. */
export async function props(plan: Plan): Promise<Scatter> {
  const scatter = new Scatter(scripts);
  scatter.name = "props";
  const placing: Promise<void>[] = [];
  for (const [id, url] of Object.entries(MODELS)) {
    const spots = plan.models.get(id);
    if (spots?.length) placing.push(scatter.place(url, copiesAt(spots)));
  }
  if (plan.fences.length) placing.push(scatter.place("/picket-fence/index.glts", copiesAt(plan.fences)));
  for (const [name, spots] of plan.streetSigns) placing.push(scatter.place(`/street-sign/index.glts?text=${encodeURIComponent(name)}`, copiesAt(spots)));
  HEDGES.forEach((url, variant) => {
    const mine = plan.hedges.filter((_, i) => i % HEDGES.length === variant);
    // each section a little lighter or darker
    const r = seedrandom(String(variant + 7));
    if (mine.length)
      placing.push(
        scatter.place(
          url,
          copiesAt(mine, () => new THREE.Color(1, 1, 1).multiplyScalar(0.85 + 0.25 * r())),
        ),
      );
  });
  for (const [name, spots] of plan.fixtures) {
    const r = seedrandom(name);
    placing.push(scatter.place(`/${name}/index.glts`, copiesAt(spots, name === "garden-shed" ? () => paint(r) : undefined)));
  }
  await Promise.all(placing);
  await scatter.seal();
  return scatter;
}

/** A shed's paint, picked by `r`. */
function paint(r: seedrandom.PRNG): THREE.Color {
  const picked = PAINTS[Math.floor(r() * PAINTS.length)];
  if (!picked) throw new Error("no shed paint picked");
  return new THREE.Color(picked);
}

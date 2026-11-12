import * as THREE from "three/webgpu";
import seedrandom from "seedrandom";
import { HOUSE_VARIANTS } from "../../public/house/params.ts";
import { scripts } from "../loading.ts";
import { copiesAt, Scatter } from "./scatter.ts";
import type { Plan } from "./plan.ts";

const WARMER = new THREE.Color(1.05, 0.98, 0.88);

/** The town's houses, each variant a little lighter or darker, warmer or not, house by house; and its church. */
export async function houses(plan: Plan): Promise<Scatter> {
  const scatter = new Scatter(scripts);
  scatter.name = "houses";
  const placing = Array.from({ length: HOUSE_VARIANTS }, (_, variant) => {
    const spots = plan.houses.filter((house) => house.variant === variant).map((house) => house.spot);
    if (!spots.length) return undefined;
    return scatter.place(
      `/house/index.glts?variant=${variant}`,
      copiesAt(spots, (_, index) => {
        const random = seedrandom(String(index * 31 + variant));
        return new THREE.Color(1, 1, 1).multiplyScalar(0.88 + 0.16 * random()).lerp(WARMER, 0.4 * random());
      }),
    );
  });
  await Promise.all([...placing, scatter.place("/house/index.glts?variant=church", copiesAt([plan.church]))]);
  await scatter.seal();
  return scatter;
}

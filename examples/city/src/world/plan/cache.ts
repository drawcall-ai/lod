import { hostEntry } from "../../cache.ts";
import { bundle } from "../../../public/content/cache.ts";
import { plan, type Plan } from "../plan.ts";
import { encode, decode } from "./codec.ts";

/** The seeded layout is independent of loaded assets and their render representations. */
export async function loadPlan(seed: number): Promise<Plan> {
  const files = await bundle(hostEntry("city-plan@4", { seed: { value: seed } }), async () => encode(plan(seed)));
  return decode(files);
}

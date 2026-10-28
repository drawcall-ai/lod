import { bundle, file } from "../cache.ts";
import { plan, type Plan } from "../plan.ts";
import { encode, decode } from "./codec.ts";

const dependencies = Object.fromEntries(
  Object.keys(import.meta.glob(["../*.ts", "../../content/**/*.ts"]))
    .sort()
    .map((path, i) => [`code:${i}`, { path: path.startsWith("../../content/") ? path.replace("../../", "src/") : path.replace("../", "src/world/") }]),
);

/** The seeded layout is independent of loaded assets and their render representations. */
export async function loadPlan(seed: number): Promise<Plan> {
  const files = await bundle(
    "plan@1",
    {
      ...dependencies,
      cache: { path: "src/world/plan/cache.ts" },
      codec: { path: "src/world/plan/codec.ts" },
      three: { package: "three" },
      seed: { value: seed },
    },
    async () => encode(plan(seed)),
  );
  return decode({ layout: file(files, "layout"), heights: file(files, "heights"), cells: file(files, "cells"), parcels: file(files, "parcels") });
}

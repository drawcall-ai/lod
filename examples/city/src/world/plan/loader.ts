import { unzipSync, zipSync } from "fflate";
import { CacheEntry, type Input } from "vitecache";
import { plan, type Plan } from "../plan.ts";
import { decode, encode } from "./codec.ts";

/** The code a plan is generated from, which Node saves each plan with. */
const code: Input[] = [
  ...Object.keys(import.meta.glob(["/src/world/**/*.ts", "/public/**/*.ts"])).map((path) => ({ path: path.slice(1) })),
  { package: "three" },
  { package: "seedrandom" },
];

/** Plans the city, which takes seconds; the vitecache plugin plans the seeds the app loads literally. */
export class CachedPlanLoader {
  async loadAsync({ seed }: { seed: number }): Promise<Plan> {
    const entry = new CacheEntry({ version: "city-plan@5", dependencies: { seed: { value: seed } } });
    let bytes = await entry.load();
    if (!bytes) {
      bytes = zipSync(await encode(plan(seed)), { level: 0 });
      await entry.save(bytes, { dependencies: code });
    }
    // A plan planned here is drawn as it decodes, as a stored one is, so both draw alike.
    return decode(unzipSync(bytes));
  }
}

import { unzipSync, zipSync } from "fflate";
import { CacheEntry } from "@drawcall/cache";
import { plan, type Plan } from "../plan.ts";
import { decode, encode } from "./codec.ts";

/** Plans the city, which takes seconds; the cache plugin plans the seeds the app loads literally, saving each with the modules planning ran. */
export class CachedPlanLoader {
  async loadAsync({ seed }: { seed: number }): Promise<Plan> {
    // Browsers read the cache below Vite's base, as the page serves it.
    const entry = new CacheEntry({ version: "city-plan@7", basePath: `${import.meta.env.BASE_URL}_cache/`, dependencies: { seed: { value: seed } } });
    let bytes = await entry.load();
    if (!bytes) {
      bytes = zipSync(await encode(plan(seed)), { level: 0 });
      await entry.save(bytes);
    }
    // A plan planned here is drawn as it decodes, as a stored one is, so both draw alike.
    return decode(unzipSync(bytes));
  }
}

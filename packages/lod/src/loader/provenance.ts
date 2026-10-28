import type { Object3D } from "three/webgpu";
import { CacheEntry, type Dependencies } from "vitecache";
import type { LodCacheOptions } from "./cache.js";

interface Origin {
  url: string;
  dependencyUrls: string[];
}

interface Script {
  entry: CacheEntry;
  origin?: Origin;
}

/** Remember GLTS imports without executing the script on a cache hit. */
export class Provenance {
  private readonly scripts = new Map<string, Script>();

  constructor(urls: string[], options?: LodCacheOptions) {
    for (const url of urls) {
      if (!/\.glts(?:[?#]|$)/i.test(url) || this.scripts.has(url)) continue;
      this.scripts.set(url, {
        entry: new CacheEntry({
          basePath: options?.basePath,
          root: options?.root,
          version: "lod-provenance@1",
          dependencies: {
            ...options?.dependencies,
            script: { url },
            query: { value: new URL(url, "https://lod.invalid").search },
            "lod:role": { value: "dependencies" },
          },
        }),
      });
    }
  }

  async load(): Promise<void> {
    await Promise.all(
      [...this.scripts.values()].map(async (script) => {
        const bytes = await script.entry.load();
        if (bytes !== undefined) script.origin = originOf(JSON.parse(new TextDecoder().decode(bytes)));
      }),
    );
  }

  get known(): boolean {
    return [...this.scripts.values()].every((script) => script.origin !== undefined);
  }

  capture(url: string, object: Object3D): void {
    const script = this.scripts.get(url);
    if (!script) return;
    script.origin = originOf(Reflect.get(object, "source"));
  }

  dependencies(inputs: Dependencies): Dependencies {
    const result = { ...inputs };
    let index = 0;
    for (const { origin } of this.scripts.values()) {
      if (!origin) throw new Error("LodLoader: GLTS dependencies have not been discovered");
      const urls = [origin.url, ...origin.dependencyUrls];
      urls.forEach((url, dependency) => {
        const key = dependency === 0 ? `glts:${index}:source` : `glts:${index}:dependency:${dependency - 1}`;
        if (key in result) throw new Error(`LodLoader: dependency name ${key} is reserved for GLTS imports`);
        result[key] = { url };
      });
      index++;
    }
    return result;
  }

  async save(): Promise<void> {
    for (const { entry, origin } of this.scripts.values()) {
      if (!origin) throw new Error("LodLoader: GLTS dependencies have not been discovered");
      await entry.save(new TextEncoder().encode(JSON.stringify(origin)));
    }
  }
}

function originOf(value: unknown): Origin {
  const url: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "url") : undefined;
  const dependencies: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "dependencyUrls") : undefined;
  if (typeof url !== "string" || !Array.isArray(dependencies)) throw new Error("LodLoader: GLTS scene.source must provide url and dependencyUrls");
  const dependencyUrls = dependencies.map((dependency: unknown) => {
    if (typeof dependency !== "string") throw new Error("LodLoader: GLTS dependency URLs must be strings");
    return dependency;
  });
  return { url, dependencyUrls };
}

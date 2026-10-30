import type { GLTSSource } from "@drawcall/glts";
import type { LoadingManager, Object3D } from "three/webgpu";
import type { Dependencies, SavedDependencies } from "vitecache";
import { isGLTSLoader, isGLTSScene } from "../three.js";
import { sha256 } from "./cache.js";
import { assetPath, isLocal, localURL, sourceRelativeURL, urlPath } from "./url.js";

/** The requested assets, and the files and packages loading them revealed, for saving with the index built from them. */
export class Provenance {
  readonly inputs: Dependencies;
  private readonly resources = new Set<string>();
  /** Kept whole: a GLTS source reports what it has observed so far, so it is read when saving. */
  private readonly scripts: GLTSSource[] = [];

  constructor(
    urls: Readonly<Record<string, string>>,
    private readonly manager: LoadingManager,
  ) {
    this.inputs = Object.fromEntries(Object.entries(urls).map(([name, url]) => [name, { url: localURL(manager.resolveURL(url)) }]));
  }

  capture(url: string, object: Object3D, result: unknown): void {
    if (assetPath(url).extension !== "glts") {
      for (const uri of gltfUrls(result, url)) this.resources.add(localURL(this.manager.resolveURL(uri)));
      return;
    }
    if (!isGLTSScene(object)) throw new Error(`LodLoader: "${url}" did not load as a GLTS scene`);
    this.scripts.push(object.source);
  }

  /** The requested URLs, resolved as `inputs` holds them. */
  get requested(): string[] {
    return Object.values(this.inputs).flatMap(({ url }) => (url === undefined ? [] : [url]));
  }

  /**
   * What the captured assets were built from so far, beyond the requested URLs, or why that cannot be validated later:
   * a CDN module fetched at runtime, which bundled moduleSources cannot vouch for, or a cross-origin resource, which
   * vitecache cannot hash.
   */
  dependencies(): { dependencies: SavedDependencies } | { reason: string } {
    if (this.scripts.some((source) => source.runtimeModules.length)) return { reason: "it imports CDN modules at runtime" };
    const found = new Set(this.resources);
    for (const source of this.scripts) for (const url of [source.url, ...source.dependencyUrls]) found.add(localURL(url));
    const inputs = this.requested;
    // A script's provenance URL carries its execution's query, so any query of an input script is that input.
    const scripts = new Set(inputs.filter((url) => assetPath(url).extension === "glts").map(urlPath));
    const urls = [...found].filter((url) => !inputs.includes(url) && !scripts.has(urlPath(url))).sort();
    const remote = urls.find((url) => !isLocal(url));
    if (remote) return { reason: `it loads the cross-origin resource "${remote}"` };
    const packages = [...new Set(this.scripts.flatMap((source) => source.packages))].sort();
    return {
      dependencies: {
        ...Object.fromEntries(urls.map((url, index) => [`resource:${index}`, { url }])),
        ...Object.fromEntries(packages.map((name) => [`package:${name}`, { package: name }])),
      },
    };
  }
}

const digests = new WeakMap<object, Promise<string>>();

/**
 * Digests of the bundled modules each input script's GLTS loader links, by input name. They are known before a source runs,
 * so they key its levels: a source's bundled module hashes come from these moduleSources. Any change to them, such as a new
 * bare import in any .glts, therefore invalidates every GLTS-derived level.
 */
export async function bundledModules(urls: Readonly<Record<string, string>>, manager: LoadingManager): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const [name, url] of Object.entries(urls)) {
    const handler = manager.getHandler(urlPath(url));
    if (!handler || !isGLTSLoader(handler)) continue;
    let digest = digests.get(handler.moduleSources);
    if (!digest) {
      // Include namespace bindings: an unused namespace can retain an old module URL.
      digest = sha256(new TextEncoder().encode(JSON.stringify(handler.moduleSources)));
      digests.set(handler.moduleSources, digest);
    }
    found[name] = await digest;
  }
  return found;
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

function gltfUrls(result: unknown, url: string): string[] {
  const parser = field(result, "parser");
  if (parser === undefined) return [];
  const json = field(parser, "json");
  if (typeof json !== "object" || json === null) throw new Error("LodLoader: glTF parser.json must provide source metadata");
  return ["buffers", "images"].flatMap((name) => {
    const resources = field(json, name);
    if (resources === undefined) return [];
    if (!Array.isArray(resources)) throw new Error(`LodLoader: glTF ${name} must be an array`);
    return resources.flatMap((resource: unknown) => {
      const uri = field(resource, "uri");
      if (uri === undefined) return [];
      if (typeof uri !== "string") throw new Error("LodLoader: glTF resource URIs must be strings");
      return /^data:/i.test(uri) ? [] : [sourceRelativeURL(uri, url)];
    });
  });
}

import { createCanvas, requestAdapter, type Canvas } from "@drawcall/webgpu";
import type { GLTSLoader } from "@drawcall/glts";
import { resolve as resolveImport } from "import-meta-resolve";
import { Loader, LoadingManager, WebGPURenderer, type Object3D } from "three/webgpu";
import { publicFile, publicURL, type Input } from "@drawcall/cache";
import { createBakeRenderer, setUpBakeRenderer } from "../bake.js";
import { adapterFormat, formatOf, type BlockFormat } from "../blocks/index.js";
import type { LodLevel } from "../levels/index.js";
import { CachedLodLoader as BrowserCachedLodLoader, type CachedLodLoaderOptions } from "./index.js";
import type { LodRequest } from "./request.js";
import { loaderPathURL, placeholderOrigin } from "./url.js";

/**
 * CachedLodLoader in Node, as the cache plugin and the glts CLI run it: `loadAsync` builds and saves every level of
 * the ladder, each with the installed versions of three and of the packages its .glts sources import; while the cache
 * plugin warms the load, it adds the public files the load read. Served paths such as `/trees/oak.glts`, and `file:`
 * URLs in the public directory, as a headless .glts script's manager resolves them to, load at the placeholder origin,
 * which its manager maps to @drawcall/cache's `publicURL` of the path; a load that requests any other URL through it,
 * or a .glts source that imports a module from a CDN, fails, since no stored level could be checked against it. `.glts`
 * sources load through a GLTSLoader of the load's own; bakes draw on a canvas of the process's document, as a glts host
 * has one, or else on a WebGPU device of @drawcall/webgpu, which every load running shares. The manager only resolves
 * the request's URL.
 *
 * Each `loadAsync` loads with what it makes for itself, which it frees before resolving, so loads may run concurrently;
 * their bakes take turns on the shared device, freed once the last load running resolves. The levels it returns load their stored bytes as in browsers, and none holds the source: the source
 * level, and a simplified level, which draws with the source's materials, load the source again when a camera needs
 * them, as the glts CLI's renders of a .glts script that draws a Lod do.
 */
export class CachedLodLoader extends BrowserCachedLodLoader {
  constructor(manager?: LoadingManager, options: CachedLodLoaderOptions = {}) {
    super(manager, options);
  }

  override loadAsync(request: LodRequest): Promise<LodLevel[]> {
    const input = typeof request === "string" ? { url: request } : request;
    const url = this.publicPath(this.manager.resolveURL(loaderPathURL(input.url, this.path)));
    return session(async () => {
      const loader = new SessionLoader(this.options);
      try {
        return await loader.loadAsync({ ...input, url });
      } finally {
        await loader.dispose();
      }
    });
  }

  /** Nothing to free: each load frees what it made. */
  override async dispose(): Promise<void> {}

  /** A `file:` URL in the public directory as its served path; others as in browsers. */
  protected override publicPath(url: string): string {
    if (!url.startsWith("file:")) return super.publicPath(url);
    const base = publicFile("/");
    if (!url.startsWith(base)) throw new Error(`CachedLodLoader: cannot precompute "${url}", which lies outside the public directory ${base}`);
    return `/${url.slice(base.length)}`;
  }
}

/** One `loadAsync` of the Node loader: builds every level, with a GLTSLoader and bake renderer of its own. */
class SessionLoader extends BrowserCachedLodLoader {
  protected override readonly buildsAll = true;
  private readonly scripts: ScriptLoader;
  /** Set once `loadAsync` has resolved, after which a level loads the source in a session of its own. */
  private disposed = false;

  constructor(options: CachedLodLoaderOptions) {
    super(publicManager(), options);
    this.scripts = new ScriptLoader(this.manager);
    this.manager.addHandler(/\.glts$/i, this.scripts);
  }

  override async dispose(): Promise<void> {
    this.disposed = true;
    await super.dispose();
    await this.scripts.dispose();
  }

  /** Load `url`, a served path; once `loadAsync` has resolved, in a session of its own. */
  protected override loadAsset(url: string): Promise<Object3D> {
    return this.disposed ? session(() => this.loadServed(url)) : this.loadServed(url);
  }

  /**
   * Load `url` at the placeholder origin, which gives a .glts source a URL its relative imports and resources resolve
   * against. In a process without a document, on the canvas's platform: three's loaders report progress with
   * ProgressEvent and decode images, which Node has not.
   */
  private async loadServed(url: string): Promise<Object3D> {
    if (typeof document === "undefined") await canvas();
    return super.loadAsset(placeholderOrigin + url);
  }

  protected override newBakeRenderer(): Promise<WebGPURenderer> {
    // A process with a document, such as a glts host's, has WebGPU of its own: bake on a canvas of that document, as a
    // .glts script does. A second WebGPU runtime beside the host's would take over globals the host's images upload with.
    if (typeof document !== "undefined") return createBakeRenderer();
    return bakeRenderer();
  }

  /** The sessions' renderer is theirs to free (see `session`); a glts host's loader frees its own. */
  protected override releaseBakeRenderer(renderer: WebGPURenderer): void {
    if (typeof document !== "undefined") renderer.dispose();
  }

  protected override async adapterFormat(): Promise<BlockFormat> {
    // As for bakes: a glts host's document has WebGPU of its own; else the adapter @drawcall/webgpu draws on.
    if (typeof document !== "undefined") return adapterFormat();
    const adapter = await requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("CachedLodLoader: @drawcall/webgpu found no adapter");
    return formatOf(adapter);
  }

  protected override inputs(): Input[] {
    // three builds every level, whatever its source imports.
    return [...new Set(["three", ...this.scripts.packages])].sort().map((name) => ({ package: name }));
  }
}

let warnedFallback = false;

/**
 * Warn, once per process, when bakes draw on @drawcall/webgpu's CPU renderer, which it falls back to when Vulkan finds
 * no GPU driver: the levels come out the same, many times slower.
 */
function warnOnFallback(renderer: WebGPURenderer): void {
  if (warnedFallback) return;
  // Three's backend types leave out its device, and @webgpu/types older than adapterInfo.
  const device: unknown = Reflect.get(renderer.backend, "device");
  const info: unknown = typeof device === "object" && device !== null ? Reflect.get(device, "adapterInfo") : undefined;
  if (typeof info !== "object" || info === null || Reflect.get(info, "isFallbackAdapter") !== true) return;
  warnedFallback = true;
  console.warn(
    `CachedLodLoader: baking on the CPU (${String(Reflect.get(info, "description"))}): WebGPU found no GPU. Install the GPU's Vulkan driver, or point the Vulkan loader at it (VK_ADD_DRIVER_FILES), for bakes on the GPU.`,
  );
}

/**
 * A manager that maps URLs at the placeholder origin to @drawcall/cache's `publicURL` of their path, which reads the public
 * file, and fails any other http(s) URL.
 */
function publicManager(): LoadingManager {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith(`${placeholderOrigin}/`)) return publicURL(url.slice(placeholderOrigin.length));
    if (/^https?:/i.test(url))
      throw new Error(`CachedLodLoader: cannot precompute a load that fetches ${url}, which a stored level cannot be checked against`);
    return url;
  });
  return manager;
}

/**
 * Loads `.glts` sources with a GLTSLoader made at the first load, resolving their packages as the app does, and
 * records the packages each imports.
 */
class ScriptLoader extends Loader<Object3D> {
  /** The installed packages the sources it loaded import. */
  readonly packages = new Set<string>();
  private loader: Promise<GLTSLoader> | undefined;

  override async loadAsync(url: string): Promise<Object3D> {
    // Packages resolve from the public directory, as the app's do.
    this.loader ??= import("@drawcall/glts").then(
      ({ GLTSLoader }) => new GLTSLoader(this.manager, { resolve: (specifier) => resolveImport(specifier, publicFile("/")) }),
    );
    const scene = await (await this.loader).loadAsync(url);
    const { packages, runtimeModules } = scene.source;
    if (runtimeModules.length > 0)
      throw new Error(
        `CachedLodLoader: cannot precompute "${url}": it imports ${runtimeModules.join(", ")} from a CDN at runtime, which a stored level cannot be checked against`,
      );
    for (const name of packages) this.packages.add(name);
    return scene;
  }

  /** Free the GLTSLoader and the scenes it loaded, resolving once freed; the next load makes another. */
  async dispose(): Promise<void> {
    const loader = this.loader;
    this.loader = undefined;
    // A GLTSLoader that failed to load failed the load that made it.
    const made = await loader?.catch(() => undefined);
    made?.dispose();
  }
}

let users = 0;
/** What sessions share while any runs: the canvas, once one loads or bakes, and the renderer, once one bakes. */
let installed: Promise<Install> | undefined;
/**
 * The disposal of the last sessions' canvas, which the next sessions wait for: @drawcall/webgpu saves and restores the
 * globals it installs per canvas, so two canvases' lives must not overlap.
 */
let restored: Promise<void> = Promise.resolve();
let current: Install | undefined;

interface Install {
  /**
   * The canvas bakes draw on in a process without a document, made by the first source load or bake, so loads that only
   * read stored levels install no WebGPU runtime.
   */
  canvas?: Promise<Canvas>;
  /**
   * The renderer every bake of the sessions draws with, on the canvas: one device whose pipelines every bake shares,
   * its bakes one at a time (see `inTurn`).
   */
  renderer?: Promise<WebGPURenderer>;
}

/** The canvas of the sessions running. */
function canvas(): Promise<Canvas> {
  if (!current) throw new Error("CachedLodLoader: baking outside loadAsync");
  return (current.canvas ??= createCanvas(1, 1));
}

/** The bake renderer of the sessions running. */
function bakeRenderer(): Promise<WebGPURenderer> {
  if (!current) throw new Error("CachedLodLoader: baking outside loadAsync");
  return (current.renderer ??= (async () => {
    // Three's DOM canvas types exclude native canvases; its constructor checks the actual API.
    const renderer: unknown = Reflect.construct(WebGPURenderer, [{ canvas: await canvas(), antialias: false, powerPreference: "high-performance" }]);
    if (!(renderer instanceof WebGPURenderer)) throw new Error("CachedLodLoader: three did not make a WebGPURenderer");
    await setUpBakeRenderer(renderer);
    warnOnFallback(renderer);
    return renderer;
  })());
}

/** Run `run` in a session: sessions running together share one canvas and bake renderer, disposed once the last ends. */
async function session<T>(run: () => Promise<T>): Promise<T> {
  users++;
  // A failed disposal failed the session that ran it.
  const shared = (installed ??= restored.catch(() => {}).then((): Install => ({})));
  try {
    current = await shared;
    return await run();
  } finally {
    if (--users === 0) {
      installed = current = undefined;
      restored = shared.then(async ({ canvas, renderer }) => {
        // A renderer or canvas that failed to make failed the bake that made it.
        (await renderer?.catch(() => undefined))?.dispose();
        await (await canvas?.catch(() => undefined))?.dispose();
      });
      await restored;
    }
  }
}

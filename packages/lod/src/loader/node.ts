import { createCanvas, type Canvas } from "@drawcall/webgpu";
import type { GLTSLoader } from "@drawcall/glts";
import { resolve as resolveImport } from "import-meta-resolve";
import { Loader, LoadingManager, WebGPURenderer, type Object3D } from "three/webgpu";
import { publicFile, publicURL, type Input } from "vitecache";
import { createBakeRenderer, setUpBakeRenderer } from "../bake.js";
import type { LodLevel } from "../levels/index.js";
import { CachedLodLoader as BrowserCachedLodLoader, type CachedLodLoaderOptions } from "./index.js";
import type { LodRequest } from "./request.js";
import { loaderPathURL, placeholderOrigin } from "./url.js";

/**
 * CachedLodLoader in Node, as the vitecache plugin and the glts CLI run it: `loadAsync` builds and saves every level of
 * the ladder, each with the installed versions of three and of the packages its .glts sources import; while the plugin
 * warms the load, vitecache adds the public files it read. Served paths such as `/trees/oak.glts`, and `file:` URLs in
 * the public directory, as a headless .glts script's manager resolves them to, load at the placeholder origin, which its
 * manager maps to vitecache's `publicURL` of the path; a load that requests any other URL through it, or a .glts source
 * that imports a module from a CDN, fails, since no stored level could be checked against it. `.glts` sources load through a
 * GLTSLoader of the load's own; bakes draw on a canvas of the process's document, as a glts host has one, or else on a
 * WebGPU device of @drawcall/webgpu. The manager only resolves the request's URL.
 *
 * Each `loadAsync` loads and bakes with what it makes for itself, which it frees before resolving, so loads may run
 * concurrently. The levels it returns load their stored bytes as in browsers, and none holds the source: the source
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

  protected override async newBakeRenderer(): Promise<WebGPURenderer> {
    // A process with a document, such as a glts host's, has WebGPU of its own: bake on a canvas of that document, as a
    // .glts script does. A second WebGPU runtime beside the host's would take over globals the host's images upload with.
    if (typeof document !== "undefined") return createBakeRenderer();
    // Three's DOM canvas types exclude native canvases; its constructor checks the actual API.
    const renderer: unknown = Reflect.construct(WebGPURenderer, [{ canvas: await canvas(), antialias: false }]);
    if (!(renderer instanceof WebGPURenderer)) throw new Error("CachedLodLoader: three did not make a WebGPURenderer");
    return setUpBakeRenderer(renderer);
  }

  protected override inputs(): Input[] {
    // three builds every level, whatever its source imports.
    return [...new Set(["three", ...this.scripts.packages])].sort().map((name) => ({ package: name }));
  }
}

/**
 * A manager that maps URLs at the placeholder origin to vitecache's `publicURL` of their path, which reads the public
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
/** What sessions share while any runs: the canvas, once one bakes. */
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
}

/** The canvas of the sessions running. */
function canvas(): Promise<Canvas> {
  if (!current) throw new Error("CachedLodLoader: baking outside loadAsync");
  return (current.canvas ??= createCanvas(1, 1));
}

/** Run `run` in a session: sessions running together share one canvas, disposed once the last ends. */
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
      restored = shared.then(async ({ canvas }) => {
        // A canvas that failed to make failed the bake that made it.
        const made = await canvas?.catch(() => undefined);
        await made?.dispose();
      });
      await restored;
    }
  }
}

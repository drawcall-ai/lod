import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCanvas, type Canvas } from "@drawcall/webgpu";
import type { GLTSLoader } from "@drawcall/glts";
import { resolve as resolveImport } from "import-meta-resolve";
import { Loader, LoadingManager, WebGPURenderer, type Object3D } from "three/webgpu";
import { publicURL, type Input } from "vitecache";
import { setUpBakeRenderer } from "../bake.js";
import type { LodLevel } from "../levels/index.js";
import { CachedLodLoader as BrowserCachedLodLoader, type CachedLodLoaderOptions } from "./index.js";
import type { LodRequest } from "./request.js";
import { loaderPathURL, placeholderOrigin } from "./url.js";

interface Session {
  /** The `file:` URLs of the public files the session's loads read. */
  read: Set<string>;
  /** The installed packages the session's .glts sources import. */
  packages: Set<string>;
}

/** The session of each load, by its async context: the served fetch is global. */
const sessions = new AsyncLocalStorage<Session>();

/**
 * CachedLodLoader in Node, as the vitecache plugin and the glts CLI run it: `loadAsync` builds and saves every level of
 * the ladder, each with the public files the ladder's loads read and the installed versions of three and of the
 * packages its .glts sources import. A load that reads anything else, such as a URL off the public directory or a module
 * a .glts source imports from a CDN, fails, since no stored level could be checked against it. Served paths such as
 * `/trees/oak.glts`, and `file:` URLs in the public directory, as a headless .glts script's manager resolves them to,
 * load from vitecache's public directory (see `publicURL`), and `.glts` sources through a GLTSLoader of the load's own;
 * bakes draw on a WebGPU device of @drawcall/webgpu. The manager only resolves the request's URL.
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
    return session({ read: new Set(), packages: new Set() }, async () => {
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
    const base = publicURL("/");
    if (!url.startsWith(base)) throw new Error(`CachedLodLoader: cannot precompute "${url}", which lies outside the public directory ${base}`);
    return `/${url.slice(base.length)}`;
  }
}

/** One `loadAsync` of the Node loader: builds every level, with a GLTSLoader and bake renderer of its own. */
class SessionLoader extends BrowserCachedLodLoader {
  protected override readonly buildsAll = true;
  private readonly scripts: ScriptLoader;

  constructor(options: CachedLodLoaderOptions) {
    super(servingManager(), options);
    // Packages resolve as the app's do.
    this.scripts = new ScriptLoader(this.manager, publicURL("/"));
    this.manager.addHandler(/\.glts$/i, this.scripts);
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    await this.scripts.dispose();
  }

  /** Load `url` in the load's session, or, once `loadAsync` has resolved, in a session of its own. */
  protected override loadAsset(url: string): Promise<Object3D> {
    if (sessions.getStore()) return super.loadAsset(url);
    return session({ read: new Set(), packages: new Set() }, () => super.loadAsset(url));
  }

  protected override newBakeRenderer(): Promise<WebGPURenderer> {
    // Three's DOM canvas types exclude native canvases; its constructor checks the actual API.
    const renderer: unknown = Reflect.construct(WebGPURenderer, [{ canvas: canvas(), antialias: false }]);
    if (!(renderer instanceof WebGPURenderer)) throw new Error("CachedLodLoader: three did not make a WebGPURenderer");
    return setUpBakeRenderer(renderer);
  }

  protected override inputs(): Input[] {
    const state = sessions.getStore();
    if (!state) throw new Error("CachedLodLoader: a level was built outside loadAsync");
    // three builds every level, whatever its source imports.
    const packages = [...new Set(["three", ...state.packages])].sort();
    return [...[...state.read].sort().map((path) => ({ path })), ...packages.map((name) => ({ package: name }))];
  }
}

/** A manager that serves root-relative paths from the public directory while a load runs. */
function servingManager(): LoadingManager {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (!url.startsWith("/") || url.startsWith("//")) return url;
    if (!sessions.getStore()) throw new Error(`CachedLodLoader: cannot load "${url}" once the load that asked for it has ended`);
    return placeholderOrigin + url;
  });
  return manager;
}

/**
 * Loads `.glts` sources with a GLTSLoader made at the first load, resolving their packages as the app at `root` does,
 * and records the packages each imports.
 */
class ScriptLoader extends Loader<Object3D> {
  private loader: Promise<GLTSLoader> | undefined;

  constructor(
    manager: LoadingManager,
    private readonly root: string,
  ) {
    super(manager);
  }

  override async loadAsync(url: string): Promise<Object3D> {
    this.loader ??= import("@drawcall/glts").then(
      ({ GLTSLoader }) => new GLTSLoader(this.manager, { resolve: (specifier) => resolveImport(specifier, this.root) }),
    );
    const scene = await (await this.loader).loadAsync(url);
    const { packages, runtimeModules } = scene.source;
    if (runtimeModules.length > 0)
      throw new Error(
        `CachedLodLoader: cannot precompute "${url}": it imports ${runtimeModules.join(", ")} from a CDN at runtime, which a stored level cannot be checked against`,
      );
    const state = sessions.getStore();
    if (!state) throw new Error(`CachedLodLoader: "${url}" loaded outside loadAsync`);
    for (const name of packages) state.packages.add(name);
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
/** What sessions install while any runs: the canvas, and what restores the globals. */
let installed: Promise<{ canvas: Canvas; restore: () => Promise<void> }> | undefined;
/**
 * The restore of the last sessions to finish, which the next install waits for: @drawcall/webgpu saves and restores
 * the globals it installs per canvas, so two canvases' lives must not overlap.
 */
let restored: Promise<void> = Promise.resolve();
let current: Canvas | undefined;

/** The canvas of the sessions running. */
function canvas(): Canvas {
  if (!current) throw new Error("CachedLodLoader: baking outside loadAsync");
  return current;
}

async function session<T>(state: Session, run: () => Promise<T>): Promise<T> {
  users++;
  // A failed restore failed the session that ran it. Sessions running together share one install.
  const shared = (installed ??= restored.catch(() => {}).then(install));
  try {
    current = (await shared).canvas;
    return await sessions.run(state, run);
  } finally {
    if (--users === 0) {
      installed = current = undefined;
      // A failed install failed the run above.
      restored = shared.then(
        ({ restore }) => restore(),
        () => {},
      );
      await restored;
    }
  }
}

/** A canvas of @drawcall/webgpu, which installs WebGPU, image decoding and workers while it lives, and the served fetch. */
async function install(): Promise<{ canvas: Canvas; restore: () => Promise<void> }> {
  const canvas = await createCanvas(1, 1);
  const { fetch } = globalThis;
  globalThis.fetch = (input, init) => serve(fetch, input, init);
  const restore = async () => {
    globalThis.fetch = fetch;
    await canvas.dispose();
  };
  return { canvas, restore };
}

async function serve(fetch: typeof globalThis.fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  const state = sessions.getStore();
  if (!state || url.protocol === "data:" || url.protocol === "blob:") return fetch(input, init);
  if (url.origin !== placeholderOrigin)
    throw new Error(`CachedLodLoader: cannot precompute a load that fetches ${url.href}, which a stored level cannot be checked against`);
  const file = publicURL(url.pathname);
  try {
    const bytes = await readFile(fileURLToPath(file));
    state.read.add(file);
    return new Response(bytes);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Response(null, { status: 404 });
    throw error;
  }
}

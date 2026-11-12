import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCanvas, type Canvas } from "@drawcall/webgpu";
import type { GLTSLoader } from "@drawcall/glts";
import { resolve as resolveImport } from "import-meta-resolve";
import { Loader, LoadingManager, WebGPURenderer, type Object3D } from "three/webgpu";
import { publicURL, type Input } from "vitecache";
import { createBakeRenderer, setUpBakeRenderer } from "../bake.js";
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
 * bakes draw on a canvas of the process's document, as a glts host has one, or else on a WebGPU device of
 * @drawcall/webgpu. The manager only resolves the request's URL.
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

  /**
   * A path its manager served at the placeholder origin as that path, which `CachedLodLoader.loadAsync` gave below the
   * app's base: keyed as in browsers whatever document the process has, such as the one a headless GLTS renderer
   * installs, against which the placeholder origin would be foreign.
   */
  protected override publicPath(url: string): string {
    return url.startsWith(`${placeholderOrigin}/`) ? url.slice(placeholderOrigin.length) : super.publicPath(url);
  }

  /**
   * Load `url` in the load's session, or, once `loadAsync` has resolved, in a session of its own. In a process without a
   * document, on the canvas's platform: three's loaders report progress with ProgressEvent and decode images, which Node
   * has not.
   */
  protected override async loadAsset(url: string): Promise<Object3D> {
    if (!sessions.getStore()) return session({ read: new Set(), packages: new Set() }, () => this.loadAsset(url));
    if (typeof document === "undefined") await canvas();
    return super.loadAsset(url);
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
/** What sessions install while any runs: the served fetch, and the canvas once one bakes. */
let installed: Promise<Install> | undefined;
/**
 * The restore of the last sessions to finish, which the next install waits for: @drawcall/webgpu saves and restores
 * the globals it installs per canvas, so two canvases' lives must not overlap.
 */
let restored: Promise<void> = Promise.resolve();
let current: Install | undefined;

interface Install {
  /**
   * The canvas bakes draw on in a process without a document, made by the first source load or bake, so loads that only
   * read stored levels install no WebGPU runtime.
   */
  canvas?: Promise<Canvas>;
  restore: () => Promise<void>;
}

/** The canvas of the sessions running. */
function canvas(): Promise<Canvas> {
  if (!current) throw new Error("CachedLodLoader: baking outside loadAsync");
  return (current.canvas ??= createCanvas(1, 1));
}

async function session<T>(state: Session, run: () => Promise<T>): Promise<T> {
  users++;
  // A failed restore failed the session that ran it. Sessions running together share one install.
  const shared = (installed ??= restored.catch(() => {}).then(install));
  try {
    current = await shared;
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

/**
 * The served fetch, and a canvas of @drawcall/webgpu once a session loads a source or bakes, which installs WebGPU,
 * image decoding and workers while it lives.
 */
function install(): Install {
  const { fetch } = globalThis;
  globalThis.fetch = (input, init) => serve(fetch, input, init);
  const made: Install = {
    restore: async () => {
      globalThis.fetch = fetch;
      // A canvas that failed to make failed the bake that made it.
      const canvas = await made.canvas?.catch(() => undefined);
      await canvas?.dispose();
    },
  };
  return made;
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

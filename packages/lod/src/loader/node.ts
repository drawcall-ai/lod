import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas, type Canvas } from "@drawcall/webgpu";
import type { GLTSLoader } from "@drawcall/glts";
import { resolve as resolveImport } from "import-meta-resolve";
import { Loader, LoadingManager, WebGPURenderer, type Object3D } from "three/webgpu";
import type { Input } from "vitecache";
import { setUpBakeRenderer } from "../bake.js";
import type { LodLevel } from "../levels/index.js";
import { CachedLodLoader as BrowserCachedLodLoader, type CachedLodLoaderOptions } from "./index.js";
import type { LodRequest } from "./request.js";
import { placeholderOrigin } from "./url.js";

interface Session {
  /** The project root, which recorded inputs are relative to. */
  root: string;
  /** The directory served paths load from. */
  publicDir: string;
  /** The public files the session's loads read, relative to `root`. */
  read: Set<string>;
  /** The installed packages the session's .glts sources import. */
  packages: Set<string>;
}

/** The session of each load, by its async context: the served fetch is global. */
const sessions = new AsyncLocalStorage<Session>();

/**
 * CachedLodLoader in Node, as the vitecache plugin runs it: `loadAsync` builds and saves every level of the ladder, each
 * with the public files the ladder's loads read and the installed versions of three and of the packages its .glts
 * sources import. A load that reads anything else, such as a URL off the public directory or a module a .glts source
 * imports from a CDN, fails, since no stored level could be checked against it. Served paths such as
 * `/trees/oak.glts` load from the public directory, and `.glts` sources through a GLTSLoader of the load's own; bakes
 * draw on a WebGPU device of @drawcall/webgpu. The project root and public directory are vitecache's: those of the
 * Vite project while the vitecache plugin runs, else `options.root` (or the working directory) and its `public`.
 *
 * Each `loadAsync` loads and bakes with what it makes for itself, which it frees before resolving, so loads may run
 * concurrently. The levels it returns load their stored bytes as in browsers, but none holds the source: loading the
 * source level, or a simplified level, which draws with the source's materials, fails once `loadAsync` has resolved.
 */
export class CachedLodLoader extends BrowserCachedLodLoader {
  private readonly site: { root: string; publicDir: string };

  constructor(manager?: LoadingManager, options: CachedLodLoaderOptions = {}) {
    if (manager)
      throw new Error(
        "CachedLodLoader: in Node, construct it without a manager: it serves the app's public files and loads .glts sources itself, which is how it records what each level was built from",
      );
    super(undefined, options);
    this.site = site(options.root);
  }

  override loadAsync(request: LodRequest): Promise<LodLevel[]> {
    const { root, publicDir } = this.site;
    return session({ root, publicDir, read: new Set(), packages: new Set() }, async () => {
      const loader = new SessionLoader(root, this.options);
      loader.setPath(this.path).setResourcePath(this.resourcePath).setCrossOrigin(this.crossOrigin);
      try {
        return await loader.loadAsync(request);
      } finally {
        await loader.dispose();
      }
    });
  }

  /** Nothing to free: each load frees what it made. */
  override async dispose(): Promise<void> {}
}

/** The vitecache plugin's project root and public directory while it runs in this process, else `root`'s. */
function site(root: string | undefined): { root: string; publicDir: string } {
  // vitecache's plugin publishes its project on globalThis.vitecache (see vitecache's shared.d.ts).
  const shared: unknown = Reflect.get(globalThis, "vitecache");
  const field = (name: string) => {
    const value: unknown = typeof shared === "object" && shared !== null ? Reflect.get(shared, name) : undefined;
    return typeof value === "string" ? value : undefined;
  };
  // As vitecache resolves an entry's root and cache directory: an explicit root is not the plugin's.
  const plugin = root === undefined ? field("directory") : undefined;
  const resolved = resolve(root ?? field("root") ?? process.cwd());
  return { root: resolved, publicDir: plugin ? dirname(plugin) : join(resolved, "public") };
}

/** One `loadAsync` of the Node loader: builds every level, with a GLTSLoader and bake renderer of its own. */
class SessionLoader extends BrowserCachedLodLoader {
  protected override readonly buildsAll = true;
  private readonly scripts: ScriptLoader;

  constructor(root: string, options: CachedLodLoaderOptions) {
    super(servingManager(), options);
    this.scripts = new ScriptLoader(this.manager, pathToFileURL(`${root}/`).href);
    this.manager.addHandler(/\.glts$/i, this.scripts);
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    await this.scripts.dispose();
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
    if (!sessions.getStore())
      throw new Error(`CachedLodLoader: cannot load "${url}" after loadAsync resolved: in Node, a ladder loads its assets only while loadAsync runs`);
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
  const file = join(state.publicDir, decodeURIComponent(url.pathname));
  try {
    const bytes = await readFile(file);
    state.read.add(relative(state.root, file));
    return new Response(bytes);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Response(null, { status: 404 });
    throw error;
  }
}

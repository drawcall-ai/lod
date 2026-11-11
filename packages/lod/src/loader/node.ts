import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
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

/** The origin loads in Node fetch the app's public directory at, as a page of the app fetches it from its own. */
const origin = "https://lod.invalid";

interface Session {
  root: string;
  /** The public files the session's loads read, relative to `root`. */
  read: Set<string>;
}

/** The session of each load, by its async context: the served fetch is global. */
const sessions = new AsyncLocalStorage<Session>();

/**
 * CachedLodLoader in Node, as the vitecache plugin runs it: `loadAsync` builds and saves every level of the ladder, each
 * with the public files the ladder's loads read and the installed version of three. Without a manager of yours,
 * served paths such as `/trees/oak.glts` load from the `public` directory below `root`, and `.glts` sources through a
 * GLTSLoader of its own; bakes draw on a WebGPU device of @drawcall/webgpu. Each load frees what it made to load and
 * bake with, so the levels it returns load nothing more once `loadAsync` has resolved.
 */
export class CachedLodLoader extends BrowserCachedLodLoader {
  protected override readonly buildsAll = true;
  private readonly root: string;
  private readonly scripts: ScriptLoader | undefined = undefined;

  constructor(manager?: LoadingManager, options: CachedLodLoaderOptions = {}) {
    super(manager ?? servingManager(), options);
    this.root = resolve(options.root ?? process.cwd());
    if (manager) return;
    this.scripts = new ScriptLoader(this.manager, pathToFileURL(`${this.root}/`).href);
    this.manager.addHandler(/\.glts$/i, this.scripts);
  }

  override loadAsync(request: LodRequest): Promise<LodLevel[]> {
    return session({ root: this.root, read: new Set() }, async () => {
      try {
        return await super.loadAsync(request);
      } finally {
        await this.dispose();
      }
    });
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    this.scripts?.dispose();
  }

  protected override newBakeRenderer(): Promise<WebGPURenderer> {
    // Three's DOM canvas types exclude native canvases; its constructor checks the actual API.
    const renderer: unknown = Reflect.construct(WebGPURenderer, [{ canvas: canvas(), antialias: false }]);
    if (!(renderer instanceof WebGPURenderer)) throw new Error("CachedLodLoader: three did not make a WebGPURenderer");
    return setUpBakeRenderer(renderer);
  }

  protected override inputs(): Input[] {
    const read = sessions.getStore()?.read;
    if (!read) throw new Error("CachedLodLoader: a level was built outside loadAsync");
    return [...[...read].sort().map((path) => ({ path })), { package: "three" }];
  }
}

function servingManager(): LoadingManager {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => (url.startsWith("/") && !url.startsWith("//") ? origin + url : url));
  return manager;
}

/** Loads `.glts` sources with a GLTSLoader made at the first load, resolving their packages as the app at `root` does. */
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
    return (await this.loader).loadAsync(url);
  }

  /** Free the GLTSLoader and the scenes it loaded; the next load makes another. */
  dispose(): void {
    const loader = this.loader;
    this.loader = undefined;
    void loader?.then((made) => made.dispose());
  }
}

let users = 0;
/** What sessions install while any runs: the canvas, and what restores the globals. */
let installed: Promise<{ canvas: Canvas; restore: () => Promise<void> }> | undefined;
let current: Canvas | undefined;

/** The canvas of the sessions running. */
function canvas(): Canvas {
  if (!current) throw new Error("CachedLodLoader: baking outside loadAsync");
  return current;
}

async function session<T>(state: Session, run: () => Promise<T>): Promise<T> {
  users++;
  try {
    installed ??= install();
    current = (await installed).canvas;
    return await sessions.run(state, run);
  } finally {
    if (--users === 0) {
      const restoring = installed;
      installed = current = undefined;
      // A failed install failed the run above.
      await restoring?.then(
        ({ restore }) => restore(),
        () => {},
      );
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
  if (url.origin !== origin || !state) return fetch(input, init);
  const file = join(state.root, "public", decodeURIComponent(url.pathname));
  try {
    const bytes = await readFile(file);
    state.read.add(relative(state.root, file));
    return new Response(bytes);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Response(null, { status: 404 });
    throw error;
  }
}

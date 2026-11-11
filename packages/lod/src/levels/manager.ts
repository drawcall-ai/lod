import type { Camera, Object3D, Object3DEventMap, Renderer } from "three/webgpu";
import type { d } from "typegpu";
import { nextTask } from "../task.js";
import { isObject3D, isScene, rootOf } from "../three.js";
import { compilerOf, type CompileFor } from "./compile/index.js";
import { CameraRenders } from "./cameras.js";
import type { RenderContext } from "./compile/contexts.js";
import { has, type DrawLevels } from "./draw.js";
import type { LodLevel } from "./index.js";
import { LoadingItem } from "./item.js";
import { CameraRequests } from "./requests.js";
import { ChunkWait } from "./wait.js";
import { ContextCompiles } from "./compiles.js";
import { busyRenderer } from "./renderer.js";

/** How long an arriving level fades in for, over what drew in its place. */
export const ARRIVAL_MS = 200;

export interface LodEventMap extends Object3DEventMap {
  /** A compiled level has joined the loaded levels. */
  levelschange: {};
  /** Fetch, decode, or GPU preparation failed; the loaded levels still draw. */
  levelserror: { error: Error };
}

/** What a Lod or InstancedLod makes of a level's loaded object: `object` compiles, then joins the loaded levels or is discarded. */
export interface PreparedLevel {
  object: Object3D;
  /** The level joins the loaded levels: it draws from now on. */
  join(): void;
  /** The compile failed, or the Lod was disposed meanwhile: free what preparing made. */
  discard(): void;
}

/** The level a load makes, while it runs and once it has made it or failed. */
interface Loading {
  promise: Promise<Object3D>;
  object?: Object3D;
  error?: Error;
}

/**
 * Loads a Lod's or InstancedLod's levels as its cameras request them, never blocking a render. The coarsest level that
 * draws something loads first, as nothing draws before it has (see levelsToDraw); the other levels a camera wants
 * start loading once it has loaded. Each level's load runs once; once the render that asked for it has ended, the Lod
 * prepares it (`prepare`), it compiles for the render context of every camera rendering the Lod and joins the loaded
 * levels. Levels join only between arrivals, each of which fades in for ARRIVAL_MS from the levels loaded `before` it.
 * Each render context seen for the first time compiles in the background every loaded level that draws something,
 * given ones included, that no camera rendering the Lod wants: three skips a draw whose pipeline a compileAsync is
 * still building, in any context that shares it, so a level a camera may draw now builds as it first draws instead.
 * Nothing is evicted: a level stays loaded until the Lod is disposed.
 *
 * A Lod draws with the first of `Lod.renderers` that renders it, whose renders it learns its cameras from. Once one
 * has, it holds an item on its LoadingManager while anything a camera wants is missing, compiling or arriving, and an
 * InstancedLod's while the GPU has not shown its chunks taken in (see `chunksChanged`).
 */
export class LodLevelLoadManager {
  /** The bits of the levels that draw: given ones from the start, deferred ones once loaded and compiled. */
  loaded = 0;
  /** The bits loaded before the latest arrival (see `progress`). */
  before = 0;
  /** The first failure; it stops further loading. */
  error: Error | undefined;
  /** Whether a render has updated the Lod: its shaders are being or have been built. */
  started = false;
  /** Its item on a LoadingManager. */
  readonly item: LoadingItem;

  /**
   * The bits of the levels that draw nothing, the coarsest level that draws something, and the order levels load in: it
   * first, then coarse to fine.
   */
  private readonly empty: number;
  private readonly coarsest: number;
  private readonly order: number[];
  /** When the latest arrival began. */
  private arrival: number | undefined;
  /** Compiled levels waiting for the arrival under way to end. */
  private readonly ready = new Map<number, PreparedLevel>();
  /** Levels being prepared and compiled to join the loaded ones. */
  private readonly arriving = new Map<number, Promise<void>>();
  /** The background compiles of loaded levels, per render context. */
  private readonly compiles: ContextCompiles;
  /** Per level, its load once started. */
  private readonly loads = new Map<number, Loading>();
  /** What renders told of the cameras that drew the Lod. */
  private readonly seen = new CameraRenders();
  private disposed = false;
  /** What `LodLevel.hold` answered, each called once the Lod is disposed. */
  private readonly releases: (() => void)[];
  /** An InstancedLod's chunks, while they wait to be shown taken in (see `chunksChanged`); null for a Lod. */
  private readonly wait: ChunkWait | null;
  /** The renderer drawing the Lod and what the cameras rendering it there asked for, once one updated it (see `bind`). */
  private bound: { readonly renderer: Renderer; readonly requests: CameraRequests } | null = null;

  constructor(
    private readonly lod: Object3D<LodEventMap>,
    /** The LoadingManager item's name, which errors name too: the kind of Lod and its uuid. */
    private readonly name: string,
    /** The levels as the Lod was given them: it holds them (see `LodLevel.hold`) until it is disposed. */
    private readonly levels: readonly LodLevel[],
    /** The levels as levelsToDraw reads them, for the ones that draw nothing and the coarsest that draws something. */
    { empty, coarsest }: d.Infer<typeof DrawLevels>,
    private readonly prepare: (level: number, loaded: Object3D) => PreparedLevel,
    /** What draws a loaded level, compiled for each render context it is wanted in. */
    private readonly drawnBy: (level: number) => readonly Object3D[],
    /** An InstancedLod's read of whether the GPU shows every chunk taken in (see `ChunkWait`); null for a Lod. */
    readChunks: (() => Promise<boolean>) | null,
  ) {
    this.loaded = this.before = levels.reduce((bits, level, i) => (level.object ? bits | (1 << i) : bits), 0);
    this.empty = empty;
    this.coarsest = coarsest;
    this.order = levels.length === 0 ? [] : [coarsest, ...[...levels.keys()].reverse().filter((level) => level !== coarsest)];
    this.releases = [...new Set(levels.flatMap(({ hold }) => (hold ? [hold] : [])))].map((hold) => hold());
    this.compiles = new ContextCompiles(
      (context, bits) => this.compileLevels(context, bits),
      (error) => this.report(error),
    );
    this.item = new LoadingItem(lod, name);
    this.wait =
      readChunks &&
      new ChunkWait(
        readChunks,
        () => this.sync(),
        (error) => this.report(error),
      );
  }

  /** How far the latest arrival has faded in, in [0, 1]: 1 once it has. */
  get progress(): number {
    if (this.arrival === undefined) return 1;
    return Math.min((performance.now() - this.arrival) / ARRIVAL_MS, 1);
  }

  /** The renderer drawing the Lod: the first of `Lod.renderers` whose render updated it; null before. */
  get renderer(): Renderer | null {
    return this.bound?.renderer ?? null;
  }

  /**
   * The renderer updating the Lod now: the one of `Lod.renderers` rendering, else the one drawing it, as when an app
   * updates it itself; null while neither is known. The first binds the Lod to it; another drawing it throws.
   */
  bind(): Renderer | null {
    const busy = busyRenderer();
    if (!this.bound) {
      if (!busy) return null;
      this.bound = { renderer: busy, requests: new CameraRequests(busy, this.seen) };
    }
    if (busy && busy !== this.bound.renderer) throw new Error(`${this.name}: another renderer than the first that rendered it drew it`);
    return this.bound.renderer;
  }

  /** Whether `camera` still renders the Lod (see `CameraRequests.rendering`). */
  rendering(camera: Camera): boolean {
    return this.bound?.requests.rendering(camera) ?? false;
  }

  get pending(): boolean {
    if (this.disposed || this.error || !this.bound) return false;
    const { requests } = this.bound;
    if (this.arriving.size > 0 || this.ready.size > 0 || (requests.needed() & ~this.loaded) !== 0) return true;
    return this.compiles.running(requests);
  }

  /**
   * `camera`, a shadow map's when `shadow`, wants the levels of the bits `wanted` (see levelsToLoad) in an update that
   * `bind` answered a renderer for: load what is missing, and answer the bits of the levels loaded now. Outside a
   * Scene a missing level is an error, as no render of it would load it.
   */
  request(camera: Camera, wanted: number, shadow: boolean): number {
    this.started = true;
    const scene = rootOf(this.lod);
    if (this.disposed || this.error) return this.loaded;
    if (!isScene(scene)) {
      if ((wanted & ~this.loaded) !== 0) throw new Error(`${this.name}: render a Scene that holds it to load the levels it needs`);
      return this.loaded;
    }
    this.item.touch();
    const { requests } = this.boundOrThrow();
    const frame = requests.set(scene, camera, wanted, shadow);
    this.load(requests, camera, shadow, frame);
    this.wait?.render();
    this.sync();
    return this.loaded;
  }

  /**
   * An InstancedLod's chunks were added or removed: hold the item until, a few renders later, the GPU shows each taken
   * in, so that a host waiting for its LoadingManager sees them drawn. A chunk the pool lacks room for is the
   * InstancedLod's error.
   */
  chunksChanged(): void {
    if (!this.wait) throw new Error(`LodLevelLoadManager: chunksChanged on ${this.name}, a Lod without chunks`);
    this.wait.changed();
    this.sync();
  }

  /**
   * The height `camera`, a shadow map's when `shadow`, draws at with `renderer` (see CameraRenders.heightOf), which
   * levels are chosen at.
   */
  heightOf(camera: Camera, renderer: Renderer, shadow: boolean): number {
    return this.seen.heightOf(camera, renderer, shadow);
  }

  /** The renderer drawing the Lod and its cameras' requests: known once a render updated it, before anything loads. */
  private boundOrThrow(): { readonly renderer: Renderer; readonly requests: CameraRequests } {
    if (!this.bound) throw new Error(`${this.name}: no renderer has updated it`);
    return this.bound;
  }

  /** What compiles for `cameras` are for: the shadow maps they drew, and the targets disposed. */
  private compileFor(cameras: Camera[]): CompileFor {
    return { shadows: this.seen.shadowsOf(cameras), isDisposed: (target) => this.seen.isDisposed(target) };
  }

  /**
   * Load what the cameras still rendering the Lod want, in `order`, compile for `camera`'s render context every loaded
   * level that draws something, none of them wants and is not yet compiled for it, and prepare the levels that have
   * loaded. `shadow` is whether a shadow map renders it, in the renderer's `frame`.
   */
  private load(requests: CameraRequests, camera: Camera, shadow: boolean, frame: number | null): void {
    const needed = requests.needed();
    const coarsestLoaded = !this.levelAt(this.coarsest).load || this.loads.get(this.coarsest)?.object !== undefined;
    for (const level of this.order) {
      const { load } = this.levelAt(level);
      if (!load || !has(needed, level) || this.loads.has(level) || (!coarsestLoaded && level !== this.coarsest)) continue;
      this.start(level, load);
    }
    // What draws never changes halfway through a frame: once a camera updated the Lod in it, as for an InstancedLod
    // its indirect draws, a shadow map rendered later joins nothing. The camera's next update does; a Lod only shadow
    // maps update joins in theirs.
    if (!shadow || requests.cameraFrame !== frame) this.join();
    const context = this.seen.contextOf(camera);
    if (!context) return;
    this.compiles.compile(context, this.compiles.claim(context, this.loaded & ~this.empty & ~needed));
    const missing = needed & ~this.loaded;
    for (const level of this.order) {
      if (!has(missing, level) || !this.loads.get(level)?.object || this.arriving.has(level) || this.ready.has(level)) continue;
      this.arrive(level, context);
    }
  }

  /** Run level `level`'s `load`, holding the object it makes. */
  private start(level: number, load: () => Promise<Object3D>): void {
    const entry: Loading = {
      promise: Promise.resolve()
        .then(load)
        .then((object) => {
          if (!isObject3D(object)) throw new Error(`${this.name}: level ${level}'s load must return an Object3D`);
          entry.object = object;
          return object;
        })
        .catch((error: unknown) => {
          entry.error = error instanceof Error ? error : new Error(`${this.name}: level ${level} failed to load`, { cause: error });
          throw entry.error;
        }),
    };
    this.loads.set(level, entry);
    void entry.promise.catch((error: unknown) => this.report(error));
  }

  private levelAt(level: number): LodLevel {
    const found = this.levels[level];
    if (!found) throw new Error(`${this.name}: no level ${level}`);
    return found;
  }

  /** Compile the loaded levels of `bits` for `context`: a background compile (see ContextCompiles). */
  private async compileLevels(context: RenderContext, bits: number): Promise<void> {
    // A context whose target was disposed meanwhile is dropped: compiling would revive the target.
    if (this.disposed || !this.seen.holds(context)) return;
    const objects = this.order.filter((level) => has(bits, level)).flatMap((level) => this.drawnBy(level));
    const { renderer, requests } = this.boundOrThrow();
    const compileFor = this.compileFor(requests.cameras());
    await Promise.all(objects.map((object) => compilerOf(renderer).compileAsync(object, context, compileFor)));
  }

  /**
   * Prepare `level` once the render that asked for it has ended, if a camera still wants it then, and compile it for
   * the render context of every camera still rendering the Lod, `context` among them, to join the loaded levels: a
   * slow level never holds another's, and no camera draws it uncompiled.
   */
  private arrive(level: number, context: RenderContext): void {
    // A render runs within one task: the next starts after it has ended.
    const done = nextTask()
      .then(async () => {
        const object = this.loads.get(level)?.object;
        const { renderer, requests } = this.boundOrThrow();
        if (this.disposed || !object || !has(requests.needed(), level)) return;
        const cameras = requests.cameras();
        // Contexts whose targets were disposed meanwhile are dropped. A camera that starts rendering the Lod while it
        // arrives draws it with pipelines built in that frame.
        const seen = [context, ...cameras.flatMap((camera) => this.seen.contextOf(camera) ?? [])];
        const contexts = new Set(seen.filter((other) => this.seen.holds(other)));
        for (const other of contexts) this.compiles.claim(other, 1 << level);
        const prepared = this.prepare(level, object);
        try {
          const compileFor = this.compileFor(cameras);
          await Promise.all([...contexts].map((other) => compilerOf(renderer).compileAsync(prepared.object, other, compileFor)));
        } catch (error) {
          prepared.discard();
          throw error;
        }
        if (this.disposed) return prepared.discard();
        this.ready.set(level, prepared);
      })
      .catch((error: unknown) => this.report(error))
      .finally(() => {
        this.arriving.delete(level);
        this.join();
      });
    this.arriving.set(level, done);
  }

  /** Let compiled levels join the loaded ones, between arrivals: what draws never changes halfway through a fade. */
  private join(): void {
    if (this.disposed || this.ready.size === 0 || this.progress < 1) return;
    this.before = this.loaded;
    for (const [level, prepared] of this.ready) {
      prepared.join();
      this.loaded |= 1 << level;
    }
    this.ready.clear();
    this.arrival = performance.now();
    queueMicrotask(() => {
      if (!this.disposed) this.lod.dispatchEvent({ type: "levelschange" });
    });
  }

  /**
   * Hold the item while levels a camera wants are missing, compiling or arriving, or chunks wait to be shown taken in,
   * and end it once they are done, so a host waiting for its LoadingManager renders its cameras complete. Called at
   * the end of each request.
   */
  private sync(): void {
    this.item.sync(this.renderer, !this.disposed && !this.error && (this.pending || (this.wait !== null && this.wait.waiting) || this.progress < 1));
  }

  /**
   * The one failure rule, for a level that fails and for anything that throws while three renders, where a throw would
   * leave its internal target bound: note the error, log it, report it on the LoadingManager the item is held on and
   * end the item, and dispatch `levelserror`. Only the first is reported; it stops further loading.
   */
  report(error: unknown): void {
    if (this.disposed || this.error) return;
    const failure = (this.error = error instanceof Error ? error : new Error("Lod: level failed", { cause: error }));
    console.error(failure);
    this.item.fail();
    this.lod.dispatchEvent({ type: "levelserror", error: failure });
  }

  /** Run `action`, part of an update or a draw callback, reporting what it throws instead. */
  guard(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.report(error);
    }
  }

  /**
   * Stop loading, then `release` what the Lod made of its levels and let go of what it holds of them (see
   * `LodLevel.hold`), once nothing preparing, compiling or loading still uses them. What the levels gave or loaded is
   * not freed: it is whoever made it's.
   */
  dispose(release: () => void): Promise<void> {
    this.disposed = true;
    this.item.sync(this.renderer, false);
    this.seen.dispose();
    for (const prepared of this.ready.values()) prepared.discard();
    this.ready.clear();
    const free = () => {
      release();
      for (const letGo of this.releases) letGo();
    };
    const finish = async () => {
      const unsettled = [...this.loads.values()].flatMap((entry) => (!entry.object && !entry.error ? [entry.promise] : []));
      // A mesh decode can begin its source-material dependency after disposal starts.
      if (unsettled.length) await Promise.allSettled(unsettled);
      free();
    };
    const tasks = [...this.arriving.values(), ...this.compiles.tasks()];
    return tasks.length > 0 ? Promise.all(tasks).then(finish) : finish();
  }
}

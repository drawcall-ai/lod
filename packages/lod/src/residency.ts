import type { Camera, Object3D, Object3DEventMap } from "three/webgpu";
import { Item } from "./item.js";
import { gpuRenderer } from "./three.js";
import { Watch, type Member } from "./watch.js";
import { at } from "./at.js";
import { compileLevel } from "./compile.js";
import { enqueue } from "./queue.js";
import { disposeTree } from "./dispose.js";
import { loadOnce, loading } from "./deferred.js";
import { fallbacks, type Level } from "./levels.js";
import { renderContext, type RenderContext } from "./view.js";

/** How long an arriving level fades in for, replacing the one that drew in its place. */
export const HANDOVER_MS = 200;

export interface LevelsEventMap extends Object3DEventMap {
  /** A compiled level has joined this LOD's draws. */
  levelschange: {};
  /** Fetch, decode, or GPU preparation failed; ready fallbacks remain drawable. */
  levelserror: { error: Error };
}

const compiledMeshes = new WeakMap<RenderContext, WeakSet<Object3D>>();

/** The meshes already compiled for `context`. */
function compiledIn(context: RenderContext): WeakSet<Object3D> {
  let compiled = compiledMeshes.get(context);
  if (!compiled) compiledMeshes.set(context, (compiled = new WeakSet()));
  return compiled;
}

/** Decode is shared by load function; readiness and handover belong to each owner. */
export class Residency implements Member {
  readonly installed = new Set<Level>();
  fallback: number[] = [];
  previous: number[] = [];
  private start: number | undefined;
  private task: { done: Promise<void>; level?: Level } | undefined;
  /** Each camera's last demand, and the scene's watch and pass it was made in (see watch.ts). */
  private readonly demands = new Map<Camera, { levels: Set<Level>; watch: Watch; pass: number }>();
  /** Whether a view updated the owner before its render was seen while levels are missing: it loads what it needs once it has. */
  private waiting = false;
  private readonly watches = new Set<Watch>();
  private readonly union = new Set<Level>();
  private readonly requested = new Set<() => Promise<Object3D>>();
  private disposed = false;
  /** The first failure; it stops further demand. */
  error: Error | undefined;
  /** Where pending levels are reported (see `sync`). */
  readonly item: Item;

  constructor(
    private readonly owner: Object3D,
    name: string,
    private readonly levels: readonly Level[],
    private readonly install: (level: Level, object: Object3D, context: RenderContext) => Promise<void>,
    private readonly changed: () => void,
    private readonly failed: (error: Error) => void,
  ) {
    this.item = new Item(owner, name);
  }

  reset(): void {
    for (const level of this.levels) if (level.object) this.installed.add(level);
    this.fallback = fallbacks(this.levels, this.installed);
  }

  get progress(): number {
    if (this.start === undefined) return 1;
    const progress = Math.min((performance.now() - this.start) / HANDOVER_MS, 1);
    if (progress === 1) this.start = undefined;
    return progress;
  }

  get pending(): boolean {
    if (this.disposed || this.error) return false;
    if (this.waiting || this.task?.level) return true;
    for (const level of this.needed()) if (!this.installed.has(level)) return true;
    return false;
  }

  /**
   * The levels needed by the cameras that updated the owner in its scene's current or last pass: each camera that
   * renders the scene once a frame counts, whatever their order, and one that stopped rendering it drops out.
   */
  private needed(): Set<Level> {
    this.union.clear();
    for (const [camera, demand] of this.demands) {
      if (demand.pass < demand.watch.pass - 1) this.demands.delete(camera);
      else for (const level of demand.levels) this.union.add(level);
    }
    return this.union;
  }

  /**
   * A view update's demand: `camera` needs the levels of `indices`. Nothing loads before the render it updates for has
   * been seen, which records the view the levels are prepared for; the item is held meanwhile.
   */
  demand(camera: Camera, indices: readonly number[]): void {
    if (this.disposed || this.error) return;
    const watch = Watch.of(this.owner, camera);
    if (!watch) {
      if (watch === null && indices.some((index) => !this.installed.has(at(this.levels, index))))
        throw new Error("Lod: render a Scene that holds it to load the levels it needs");
      // The render's view is not known yet: any missing level may be the one it needs.
      this.waiting = this.levels.some((level) => !this.installed.has(level));
      return;
    }
    this.waiting = false;
    gpuRenderer(watch.renderer);
    watch.join(this);
    this.watches.add(watch);
    let demand = this.demands.get(camera);
    if (!demand) this.demands.set(camera, (demand = { levels: new Set(), watch, pass: watch.pass }));
    demand.watch = watch;
    demand.pass = watch.pass;
    demand.levels.clear();
    for (const index of indices) {
      const level = at(this.levels, index);
      demand.levels.add(level);
      const fallback = at(this.fallback, index);
      if (fallback >= 0) demand.levels.add(at(this.levels, fallback));
      const load = level.input.load;
      if (!load || this.requested.has(load)) continue;
      this.requested.add(load);
      void loadOnce(load).promise.catch((error: unknown) => this.report(error));
    }
  }

  drawn(camera: Camera, object: Object3D): void {
    // compileAsync also runs draw callbacks; its queued job records success itself.
    if (this.task) return;
    const context = renderContext(camera);
    if (!context) return;
    compiledIn(context).add(object);
  }

  update(camera: Camera, meshes?: readonly (readonly Object3D[])[]): void {
    const context = renderContext(camera);
    if (!context || this.disposed || this.task || this.error || this.progress < 1) return;
    const compiled = compiledIn(context);
    const needed = this.needed();
    const eager = this.levels.findIndex((level, index) => !level.input.load && needed.has(level) && meshes?.[index]?.some((mesh) => !compiled.has(mesh)));
    const pending = meshes?.[eager];
    if (pending) {
      this.run(async () => {
        for (const mesh of pending) {
          if (compiled.has(mesh)) continue;
          await compileLevel(mesh, context);
          compiled.add(mesh);
        }
      });
      return;
    }
    for (const level of this.levels) {
      const object = level.input.load && loading(level.input.load)?.object;
      if (!object || !needed.has(level) || this.installed.has(level)) continue;
      this.run(async () => {
        await this.install(level, object, context);
        if (this.disposed) return;
        const before = this.fallback;
        this.installed.add(level);
        this.fallback = fallbacks(this.levels, this.installed);
        // Only what drew before hands over: a level that replaces nothing draws at once.
        if (!this.fallback.some((index, i) => index !== before[i] && at(before, i) >= 0)) return;
        this.previous = before;
        this.start = performance.now();
      }, level);
      return;
    }
  }

  /** A scene rendered a whole pass without updating the owner: it no longer draws there. */
  idle(): void {
    this.item.held = false;
  }

  /**
   * Holds the item while the levels the views need load, install, compile or hand over, and ends it once they are done,
   * so a host waiting for its manager renders the views complete. Called at the end of each update. Levels stay
   * installed once loaded, until the owner is disposed: nothing is evicted.
   */
  sync(): void {
    this.item.held = !this.disposed && !this.error && (this.pending || this.task !== undefined || this.progress < 1);
  }

  private run(action: () => Promise<void>, level?: Level): void {
    const done = enqueue(
      async () => {
        if (!this.disposed) await action();
      },
      level ? 0 : 1,
    )
      .catch((error: unknown) => this.report(error))
      .finally(() => {
        this.task = undefined;
      })
      .then(() => {
        if (level && !this.disposed && this.installed.has(level)) this.changed();
      });
    this.task = { done, level };
  }

  /**
   * The one failure rule, for a level that fails and for anything that throws while three renders, where a throw would
   * leave its internal target bound: record the error, log it, report it on the manager and end the item. Only the
   * first is kept; it stops further demand.
   */
  report(error: unknown): void {
    if (this.disposed || this.error) return;
    this.error = error instanceof Error ? error : new Error("Lod: level failed", { cause: error });
    console.error(this.error);
    this.item.fail();
    this.failed(this.error);
  }

  /** Run `action`, part of an update or a draw callback, reporting what it throws instead. */
  guard(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.report(error);
    }
  }

  dispose(release: () => void): void {
    this.disposed = true;
    this.item.held = false;
    for (const watch of this.watches) watch.leave(this);
    const free = () => {
      release();
      const templates = new Set<Object3D>();
      for (const { input } of this.levels) {
        const object = input.object ?? loading(input.load)?.object;
        if (object) templates.add(object);
      }
      for (const template of templates) disposeTree(template);
      for (const { input } of this.levels) input.dispose?.();
    };
    const finish = () => {
      const pending = this.levels.flatMap(({ input }) => {
        const entry = input.load && loading(input.load);
        return entry && !entry.object && !entry.error ? [entry.promise] : [];
      });
      // A mesh decode can begin its source-material dependency after disposal starts.
      if (pending.length) void Promise.allSettled(pending).then(free);
      else free();
    };
    if (this.task) void this.task.done.then(finish);
    else finish();
  }
}

type Pair = readonly [level: number, finer: number, fade: number];

/** Collapse the old height fade, exchange detail, then restore the new height fade. */
export function handover(before: Pair, after: Pair, progress: number): Pair {
  let [level, finer, fade] = after;
  if (progress >= 1 || (before[0] === level && before[1] === finer)) return after;
  if (progress < 1 / 3) {
    [level, finer] = before;
    fade = before[2] > 0 ? before[2] + (1 - before[2]) * progress * 3 : 0;
  } else if (progress < 2 / 3) {
    level = fade > 0 ? finer : level;
    finer = before[2] > 0 ? before[1] : before[0];
    fade = 1 - (progress - 1 / 3) * 3;
  } else fade = fade > 0 ? 1 - (1 - fade) * (progress - 2 / 3) * 3 : 0;
  return [level, finer, level === finer ? 0 : fade];
}

import type { Camera, Object3D, Object3DEventMap } from "three/webgpu";
import { at } from "./at.js";
import { compileLevel } from "./compile.js";
import { enqueue } from "./queue.js";
import { disposeTree } from "./dispose.js";
import { loadOnce, loading } from "./deferred.js";
import { fallbacks, type Level } from "./levels.js";
import { renderContext, type RenderContext } from "./view.js";

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
export class Residency {
  readonly ready = new Set<Level>();
  fallback: number[] = [];
  previous: number[] = [];
  private start: number | undefined;
  private task: { done: Promise<void>; level?: Level } | undefined;
  private readonly demanded = new Set<Level>();
  private readonly requested = new Set<() => Promise<Object3D>>();
  private disposed = false;
  /** The first failure; it stops further demand. */
  error: Error | undefined;

  constructor(
    private readonly levels: readonly Level[],
    private readonly install: (level: Level, object: Object3D, context: RenderContext) => Promise<void>,
    private readonly changed: () => void,
    private readonly failed: (error: Error) => void,
  ) {}

  reset(): void {
    for (const level of this.levels) if (level.object) this.ready.add(level);
    this.fallback = fallbacks(this.levels, this.ready);
  }

  get progress(): number {
    if (this.start === undefined) return 1;
    const progress = Math.min((performance.now() - this.start) / HANDOVER_MS, 1);
    if (progress === 1) this.start = undefined;
    return progress;
  }

  get pending(): boolean {
    if (this.disposed || this.error) return false;
    if (this.task?.level) return true;
    for (const level of this.demanded) if (!this.ready.has(level)) return true;
    return false;
  }

  demand(camera: Camera, indices: Iterable<number>): void {
    this.demanded.clear();
    if (this.disposed || this.error || !renderContext(camera)) return;
    for (const index of indices) {
      const level = at(this.levels, index);
      this.demanded.add(level);
      const fallback = at(this.fallback, index);
      if (fallback >= 0) this.demanded.add(at(this.levels, fallback));
      const load = level.input.load;
      if (!load || this.requested.has(load)) continue;
      this.requested.add(load);
      void loadOnce(load).promise.catch((error: unknown) => this.report(error));
    }
  }

  needsDemand(camera: Camera, meshes: readonly (readonly Object3D[])[]): boolean {
    if (this.ready.size < this.levels.length || this.progress < 1) return true;
    const context = renderContext(camera);
    if (!context) return false;
    const compiled = compiledMeshes.get(context);
    return this.levels.some(({ input }, index) => !input.load && meshes[index]?.some((mesh) => !compiled?.has(mesh)));
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
    const eager = this.levels.findIndex(
      (level, index) => !level.input.load && this.demanded.has(level) && meshes?.[index]?.some((mesh) => !compiled.has(mesh)),
    );
    const pending = meshes?.[eager];
    if (pending) {
      this.run(async () => {
        const results = await Promise.allSettled(
          pending.map(async (mesh) => {
            if (compiled.has(mesh)) return;
            await compileLevel(mesh, context);
            compiled.add(mesh);
          }),
        );
        for (const result of results) if (result.status === "rejected") throw result.reason;
      });
      return;
    }
    for (const level of this.levels) {
      const object = level.input.load && loading(level.input.load)?.object;
      if (!object || !this.demanded.has(level) || this.ready.has(level)) continue;
      this.run(async () => {
        await this.install(level, object, context);
        if (this.disposed) return;
        this.previous = this.fallback;
        this.ready.add(level);
        this.fallback = fallbacks(this.levels, this.ready);
        this.start = performance.now();
      }, level);
      return;
    }
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
        if (level && !this.disposed && this.ready.has(level)) this.changed();
      });
    this.task = { done, level };
  }

  private report(error: unknown): void {
    if (this.disposed || this.error) return;
    this.error = error instanceof Error ? error : new Error("Lod: level failed", { cause: error });
    this.failed(this.error);
    console.error(this.error);
  }

  dispose(release: () => void): void {
    this.disposed = true;
    const free = () => {
      release();
      const templates = new Set<Object3D>();
      for (const { input } of this.levels) {
        const object = input.object ?? loading(input.load)?.object;
        if (object) templates.add(object);
      }
      for (const template of templates) disposeTree(template);
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

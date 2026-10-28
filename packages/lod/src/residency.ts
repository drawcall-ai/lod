import type { Camera, Object3D, Object3DEventMap } from "three/webgpu";
import { compileLevel, queueInstall } from "./install.js";
import { type LazyLevel } from "./lazy.js";
import { fallbacks, type LodLevel } from "./levels.js";
import { isLazyLevel } from "./three.js";
import { renderContext, type RenderContext } from "./view.js";

export const HANDOVER_MS = 200;

export interface LevelsEventMap extends Object3DEventMap {
  /** A compiled level has joined this LOD's draws. */
  levelschange: {};
  /** Fetch, decode, or GPU preparation failed; installed fallbacks remain drawable. */
  levelserror: { error: unknown };
}

const compiled = new WeakMap<RenderContext, WeakSet<Object3D>>();

/** Decoding is shared by LazyLevel; residency and the handover belong to each owner. */
export class Residency {
  readonly installed = new Set<Object3D>();
  private objects: Object3D[] = [];
  fallback: number[] = [];
  previous: number[] = [];
  private start: number | undefined;
  private task: { done: Promise<void>; lazy?: LazyLevel } | undefined;
  private readonly demanded = new Set<Object3D>();
  private disposed = false;
  private failure: Error | undefined;

  get error(): Error | undefined {
    if (this.failure) return this.failure;
    for (const object of this.demanded) if (isLazyLevel(object) && object.error) return object.error;
    return undefined;
  }

  constructor(
    private readonly levels: readonly LodLevel[],
    private readonly install: (index: number, lazy: LazyLevel, context: RenderContext) => Promise<void>,
    private readonly changed: () => void,
    private readonly failed: (error: unknown) => void,
  ) {}

  reset(): void {
    this.objects = this.levels.map(({ object }) => object);
    for (const object of this.objects) if (!isLazyLevel(object)) this.installed.add(object);
    this.fallback = fallbacks(this.objects, this.installed);
  }

  get progress(): number {
    if (this.start === undefined) return 1;
    const progress = Math.min((performance.now() - this.start) / HANDOVER_MS, 1);
    if (progress === 1) this.start = undefined;
    return progress;
  }

  get pending(): boolean {
    if (this.disposed || this.error) return false;
    if (this.task?.lazy) return true;
    for (const object of this.demanded) if (!this.installed.has(object)) return true;
    return false;
  }

  demand(camera: Camera, indices: Iterable<number>): void {
    this.demanded.clear();
    if (this.disposed || !renderContext(camera)) return;
    for (const index of indices) {
      const level = this.levels[index];
      if (!level) throw new Error(`LOD: missing level ${index}`);
      const object = level.object;
      this.demanded.add(object);
      const target = this.fallback[index];
      const fallback = target === undefined ? undefined : this.objects[target];
      if (!fallback) throw new Error(`LOD: missing fallback ${index}`);
      this.demanded.add(fallback);
      if (isLazyLevel(object) && !object.promise) void object.load().catch((error: unknown) => this.report(error));
    }
  }

  needsDemand(camera: Camera, meshes: readonly (readonly Object3D[])[]): boolean {
    if (this.installed.size < this.levels.length || this.progress < 1) return true;
    const context = renderContext(camera);
    if (!context) return false;
    const warmed = compiled.get(context);
    return this.levels.some(({ object }, index) => !isLazyLevel(object) && meshes[index]?.some((draw) => !warmed?.has(draw)));
  }

  drawn(camera: Camera, object: Object3D): void {
    // compileAsync also runs draw callbacks; its queued job records success itself.
    if (this.task) return;
    const context = renderContext(camera);
    if (!context) return;
    let warmed = compiled.get(context);
    if (!warmed) compiled.set(context, (warmed = new WeakSet()));
    warmed.add(object);
  }

  update(camera: Camera, meshes?: readonly (readonly Object3D[])[]): void {
    const context = renderContext(camera);
    if (!context || this.disposed || this.task || this.error) return;
    if (this.progress < 1) return;
    let warmed = compiled.get(context);
    if (!warmed) compiled.set(context, (warmed = new WeakSet()));
    const eager = this.levels.findIndex(
      ({ object }, index) => !isLazyLevel(object) && this.demanded.has(object) && meshes?.[index]?.some((draw) => !warmed.has(draw)),
    );
    const draws = meshes?.[eager];
    if (draws) {
      this.run(async () => {
        const results = await Promise.allSettled(
          draws.map(async (draw) => {
            if (warmed.has(draw)) return;
            await compileLevel(draw, context);
            warmed.add(draw);
          }),
        );
        for (const result of results) if (result.status === "rejected") throw result.reason;
      });
      return;
    }
    const level = this.levels.find(({ object }) => isLazyLevel(object) && object.object && this.demanded.has(object) && !this.installed.has(object));
    if (level && isLazyLevel(level.object)) {
      const lazy = level.object;
      this.run(async () => {
        await this.install(this.levels.indexOf(level), lazy, context);
        if (this.disposed) return;
        this.previous = this.fallback;
        this.installed.add(lazy);
        this.fallback = fallbacks(this.objects, this.installed);
        this.start = performance.now();
      }, lazy);
    }
  }

  private run(action: () => Promise<void>, lazy?: LazyLevel): void {
    const done = queueInstall(
      async () => {
        if (!this.disposed) await action();
      },
      lazy ? 0 : 1,
    )
      .catch((error: unknown) => {
        this.failure = error instanceof Error ? error : new Error("LOD: preparation failed", { cause: error });
        this.report(this.failure);
      })
      .finally(() => {
        this.task = undefined;
      })
      .then(() => {
        if (lazy && !this.disposed && this.installed.has(lazy)) this.changed();
      });
    this.task = { done, lazy };
  }

  private report(error: unknown): void {
    this.failed(error);
    console.error(error);
  }

  dispose(release: () => void): void {
    this.disposed = true;
    if (this.task) void this.task.done.then(release);
    else release();
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

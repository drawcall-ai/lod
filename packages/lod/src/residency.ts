import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
  type Camera,
  type Object3D,
  type Object3DEventMap,
  type Renderer,
} from "three/webgpu";
import { Item } from "./item.js";
import { busy, gpuRenderer, inShadowPass, isScene, rootOf, skipDraw } from "./three.js";
import { at } from "./at.js";
import { compileLevel } from "./compile/index.js";
import { pause } from "./pause.js";
import { disposeTree } from "./dispose.js";
import { loadOnce, loading } from "./deferred.js";
import { fallbacks, type Level } from "./levels.js";
import { recordRender, renderContext, type RenderContext } from "./view.js";

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

/** A camera's last demand, and the pass and, a shadow map's, the renderer's frame it was made in. */
interface Demand {
  levels: Set<Level>;
  pass: number;
  frame: number | null;
}

/** How long a held item waits between looks at its renderer's renders (see `look`): a frame's time. */
const LOOK_MS = 16;

/** What learns an owner's renderer (see `ask`): one degenerate triangle, which would draw nothing were it drawn. */
const probeGeometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(new Float32Array(9), 3));
const probeMaterial = new MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false });
// Drawn as itself under any scene.overrideMaterial, so that three hands its draw on once: the call skipped.
probeMaterial.allowOverride = false;

/**
 * A mesh that meets every render or compile reaching it, ahead of the draws that render shadow maps, with its renderer,
 * and draws nothing.
 */
export function meeting(meet: (renderer: Renderer, scene: Object3D, camera: Camera) => void): Mesh {
  const mesh = new Mesh(probeGeometry, probeMaterial);
  mesh.frustumCulled = false;
  mesh.layers.enableAll();
  mesh.renderOrder = -Infinity;
  mesh.onBeforeRender = (renderer, scene, camera) => {
    const gpu = gpuRenderer(renderer);
    skipDraw(gpu);
    meet(gpu, scene, camera);
  };
  return mesh;
}

/** Decode is shared by load function; readiness and handover belong to each owner. */
export class Residency {
  readonly installed = new Set<Level>();
  fallback: number[] = [];
  previous: number[] = [];
  private start: number | undefined;
  /** Independent preparations: a slow level never holds another level's first drawable. */
  private readonly tasks = new Map<Level | Object3D, Promise<void>>();
  /** Compiled arrivals waiting for the current handover to end before changing its routes. */
  private readonly ready = new Set<Level>();
  /** Each camera's last demand, and the pass it was made in. */
  private readonly demands = new Map<Camera, Demand>();
  /** Whether a view updated the owner before its renderer was known while levels are missing: it loads what it needs once it is. */
  private waiting = false;
  /**
   * The renderer's updates of the owner, counted in passes: a pass ends when a camera updates it a second time, so a
   * pass holds one update by each camera that renders it once a frame, whatever their order. Shadow maps do not count.
   */
  private pass = 0;
  /** The cameras that updated the owner in the pass in progress. */
  private readonly cameras = new Set<Camera>();
  /** The mesh asking which renderer draws the owner, while it asks (see `ask`). */
  private probe: Mesh | undefined;
  /**
   * Whether the owner was updated since the item's last look at its renderer, the renders counted at that look, and
   * whether a look is due (see `look`).
   */
  private updated = false;
  private renders = 0;
  private looking = false;
  private readonly union = new Set<Level>();
  private readonly requested = new Set<() => Promise<Object3D>>();
  private disposed = false;
  /** What draws the owner: the first renderer that drew it. */
  private renderer: Renderer | undefined;
  /** The first failure; it stops further demand. */
  error: Error | undefined;
  /** Where pending levels are reported (see `sync`). */
  readonly item: Item;

  constructor(
    private readonly owner: Object3D,
    private readonly name: string,
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

  /** Whether a render has updated the owner: its shaders are being or have been built. */
  started = false;
  /** Whether the owner's GPU chunks wait to be taken in, which holds the item as pending levels do (see `Intake`). */
  taking = false;

  get progress(): number {
    if (this.start === undefined) return 1;
    const progress = Math.min((performance.now() - this.start) / HANDOVER_MS, 1);
    if (progress === 1) this.start = undefined;
    return progress;
  }

  get pending(): boolean {
    if (this.disposed || this.error) return false;
    if (this.waiting || this.tasks.size > 0 || this.ready.size > 0) return true;
    for (const level of this.needed()) if (!this.installed.has(level)) return true;
    return false;
  }

  /**
   * The levels needed by the cameras that still view the owner (see `viewing`): each camera that renders the scene
   * once a frame counts, whatever their order, and one that stopped rendering it drops out.
   */
  private needed(): Set<Level> {
    this.union.clear();
    for (const [camera, demand] of this.demands) {
      if (!this.fresh(demand)) this.demands.delete(camera);
      else for (const level of demand.levels) this.union.add(level);
    }
    return this.union;
  }

  /**
   * Whether `demand` still counts: made in the current or last pass, or a shadow map's made this frame. three draws a
   * shadow map at most once a frame for each view, so a view rendered again in the frame keeps drawing the map the last
   * selection filled.
   */
  private fresh(demand: Demand): boolean {
    return demand.pass >= this.pass - 1 || (demand.frame !== null && demand.frame === this.renderer?.info.frame);
  }

  /** Whether `camera` updated the owner in the current or last pass, or, a shadow map's, in this frame. */
  viewing(camera: Camera): boolean {
    const demand = this.demands.get(camera);
    return demand !== undefined && this.fresh(demand);
  }

  /**
   * An update by `camera`, a view's or a shadow map's, of an owner in a Scene. One its renderer makes as it renders
   * or compiles the Scene records the camera's render context and viewport height there, or the shadow map, and counts
   * in the passes. Any other, before the renderer is known, by the app, or by another renderer, asks which renderer
   * draws the owner.
   */
  view(camera: Camera): void {
    const scene = rootOf(this.owner);
    if (this.disposed || this.error || !isScene(scene)) return;
    this.updated = true;
    const { renderer } = this;
    if (!renderer || !busy(renderer)) return this.ask();
    recordRender(renderer, scene, camera);
    if (inShadowPass(scene)) return;
    if (this.cameras.has(camera)) {
      this.pass++;
      this.cameras.clear();
    }
    this.cameras.add(camera);
  }

  /**
   * Learn which renderer draws the owner, and where: three hands a renderer only to what it draws, and the owner may
   * draw nothing yet. A mesh under the owner meets the next render or compile that reaches it, records it as `view`
   * does, and leaves. It builds and draws nothing: its draw is skipped. A second renderer is the owner's error.
   */
  private ask(): void {
    if (this.probe) return;
    const probe: Mesh = (this.probe = meeting((gpu, scene, camera) =>
      this.guard(() => {
        if (this.probe !== probe) return;
        this.probe = undefined;
        probe.removeFromParent();
        this.renderer ??= gpu;
        if (gpu !== this.renderer) throw new Error(`${this.name}: a second renderer drew it; an owner draws with the first renderer that drew it only`);
        if (isScene(scene)) recordRender(gpu, scene, camera);
      }),
    ));
    this.owner.add(probe);
  }

  /**
   * A view update's demand: `camera` needs the levels of `indices`. Nothing loads before the owner's renderer is known
   * (see `ask`), which prepares the levels for the view; the item is held meanwhile.
   */
  demand(camera: Camera, indices: readonly number[]): void {
    this.started = true;
    if (this.disposed || this.error) return;
    if (!isScene(rootOf(this.owner))) {
      if (indices.some((index) => !this.installed.has(at(this.levels, index))))
        throw new Error("Lod: render a Scene that holds it to load the levels it needs");
      return;
    }
    const { renderer } = this;
    // Until the renderer is known, any missing level may be the one the view needs.
    this.waiting = !renderer && this.levels.some((level) => !this.installed.has(level));
    if (!renderer) return;
    let demand = this.demands.get(camera);
    if (!demand) this.demands.set(camera, (demand = { levels: new Set(), pass: this.pass, frame: null }));
    demand.pass = this.pass;
    demand.frame = inShadowPass(this.owner) ? renderer.info.frame : null;
    demand.levels.clear();
    for (const index of indices) {
      const level = at(this.levels, index);
      demand.levels.add(level);
      const fallback = at(this.fallback, index);
      if (fallback >= 0) demand.levels.add(at(this.levels, fallback));
      else if (!level.empty) {
        // The first view need not wait for its most expensive detail to draw anything.
        const coarsest = this.levels.slice(index + 1).reverse().find((candidate) => !candidate.empty);
        if (coarsest) demand.levels.add(coarsest);
      }
    }
    for (const level of demand.levels) {
      const load = level.input.load;
      if (!load || this.requested.has(load)) continue;
      this.requested.add(load);
      void loadOnce(load).promise.catch((error: unknown) => this.report(error));
    }
  }

  drawn(camera: Camera, object: Object3D): void {
    // compileAsync also runs draw callbacks; its task records success itself.
    if (this.tasks.size > 0) return;
    const context = renderContext(camera);
    if (!context) return;
    compiledIn(context).add(object);
  }

  update(camera: Camera, meshes?: readonly (readonly Object3D[])[]): void {
    const context = renderContext(camera);
    if (!context || this.disposed || this.error) return;
    this.flush();
    const compiled = compiledIn(context);
    const needed = this.needed();
    const given = this.levels.flatMap((level, index) =>
      !level.input.load && needed.has(level) ? (meshes?.[index] ?? []).filter((mesh) => !compiled.has(mesh) && !this.tasks.has(mesh)) : [],
    );
    const arriving = this.levels.flatMap((level) => {
      const object = level.input.load && loading(level.input.load)?.object;
      return object && needed.has(level) && !this.installed.has(level) && !this.ready.has(level) && !this.tasks.has(level) ? [{ level, object }] : [];
    });
    for (const mesh of given)
      this.run(mesh, async () => {
        await compileLevel(mesh, context);
        compiled.add(mesh);
      });
    for (const { level, object } of arriving)
      this.run(level, async () => {
        await this.install(level, object, context);
        if (!this.disposed) this.ready.add(level);
      });
  }

  /** Ready levels join between handovers; a route never changes halfway through its fade. */
  private flush(): void {
    if (this.disposed || this.ready.size === 0 || this.progress < 1) return;
    const before = this.fallback;
    for (const level of this.ready) this.installed.add(level);
    this.ready.clear();
    this.fallback = fallbacks(this.levels, this.installed);
    if (at(before, 0) >= 0 && this.fallback.some((index, i) => index !== before[i])) {
      this.previous = before;
      this.start = performance.now();
    }
    queueMicrotask(() => {
      if (!this.disposed) this.changed();
    });
  }

  /**
   * Holds the item while the levels the views need load, install, compile or hand over, or GPU chunks wait to be taken
   * in, and ends it once they are done, so a host waiting for its manager renders the views complete. Called at the end of each update. Levels stay
   * installed once loaded, until the owner is disposed: nothing is evicted.
   */
  sync(): void {
    this.item.held = !this.disposed && !this.error && (this.pending || this.taking || this.progress < 1);
    if (!this.item.held || !this.renderer || this.looking) return;
    // The first look only counts the renders: those still to come in this render are not without an update.
    this.updated = true;
    this.look(this.renderer);
  }

  /**
   * While the item is held, look a frame's time apart at the renderer's renders: an object its renderer rendered around
   * for a frame without updating it (hidden, on a layer no camera tests, out of the scene) ends its item; its next
   * update starts it again. Renders of other scenes in a separate task can end it early, and the next update reopens
   * it; a renderer that only compiles keeps a hidden owner's item held.
   */
  private look(renderer: Renderer): void {
    this.looking = true;
    const timer: unknown = setTimeout(() => {
      this.looking = false;
      if (!this.item.held) return;
      const renders = renderer.info.render.calls;
      if (renders !== this.renders && !this.updated) return void (this.item.held = false);
      this.renders = renders;
      this.updated = false;
      this.look(renderer);
    }, LOOK_MS);
    // A held item must not keep Node.js running.
    if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref();
  }

  /** Run `action` outside the render that asked for it, which may still be walking the scene. */
  private run(key: Level | Object3D, action: () => Promise<void>): void {
    const done = pause()
      .then(async () => {
        if (!this.disposed) await action();
      })
      .catch((error: unknown) => this.report(error))
      .finally(() => {
        this.tasks.delete(key);
        this.flush();
      });
    this.tasks.set(key, done);
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
    this.probe?.removeFromParent();
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
    if (this.tasks.size > 0) void Promise.all(this.tasks.values()).then(finish);
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

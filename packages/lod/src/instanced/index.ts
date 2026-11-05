import {
  type Color,
  Frustum,
  type Matrix4,
  Object3D,
  Sphere,
  Vector3,
  type Camera,
  type Intersection,
  type LoadingManager,
  type Raycaster,
} from "three/webgpu";
import { at } from "../at.js";
import { disposeCopies } from "../dispose.js";
import { Level, cloneLevels, estimate, fadeProgress, levelAt, tintLevels, validate, type LevelView, type LodLevel } from "../levels.js";
import { Lod, type LodOptions } from "../lod.js";
import { Residency, type LevelsEventMap } from "../residency.js";
import { inShadowPass, sameClass } from "../three.js";
import { TYPICAL_HEIGHT, View, viewportHeight, type RenderContext } from "../view.js";
import { compileLevel } from "../compile.js";
import { WIND } from "../wind/hooks.js";
import { copyWind, refreshWind } from "../wind/index.js";
import { Meshes } from "./meshes.js";
import { parts } from "./parts.js";
import { Blocks } from "./blocks.js";
import { sight, type Aim } from "./sight.js";
import { Extent } from "./extent.js";
import { Probes } from "./raycast.js";
import { Selection } from "./select.js";
import { Store } from "./store.js";

const view = new View();

/**
 * Independently selected copies of one object, batched into indirect draws per view.
 * Thresholds, fades and global settings follow Lod. Each view draws only the instances in
 * its frustum, and each shadow map is a view of its own: it draws the casters in its
 * frustum, each at the level its texels resolve, as an orthographic view would (an
 * instance smaller than a texel casts nothing). Each level's bounds tighten to the region
 * where its instances can draw. Instance matrices may scale arbitrarily;
 * the crowd's own transform and its parents should scale uniformly. Scale 0 draws nothing.
 *
 * Level templates are cloned, then their meshes are instanced. Skinned meshes,
 * InstancedMeshes (except ImpostorMesh) and nested Lods are unsupported. For external
 * detail, leave level 0 empty and draw the instances that `levelOf` reports there.
 *
 * Requires WebGPU `indirect-first-instance`. Sequential cameras are supported; nested
 * renders replace the outer selection, so exclude this crowd with camera layers.
 */
export class InstancedLod extends Object3D<LevelsEventMap> {
  readonly isLOD = true;
  readonly isInstancedLod = true;
  /** Let the renderer call `update` with its camera every frame. */
  autoUpdate = true;
  /** Draw only this level for every instance, without fades. */
  forceLevel: number | null = null;
  readonly levels: readonly LevelView[];
  readonly count: number;

  private readonly entries: Level[] = [];
  private readonly probes: Probes;
  private selection: Selection | null = null;
  private meshes: Meshes | null = null;
  private readonly residency: Residency;
  private disposed = false;
  private readonly store: Store;
  private readonly extent = new Extent();
  /** Around every instance; each level may use tighter bounds. */
  readonly bounds = new Sphere();
  private blocks: Blocks;
  /** The last view `update` selected for, for `levelOf`, once there was one. */
  private readonly last: Aim = { eye: new Vector3(), scale: 0, ortho: false, fades: false, forced: null, frustum: new Frustum() };
  private selected = false;
  /** The shadow map `update` last selected for. */
  private readonly shadowView: Aim = { eye: new Vector3(), scale: 0, ortho: true, fades: false, forced: null, frustum: new Frustum() };

  get pending(): boolean {
    return this.residency.pending;
  }
  get error(): Error | undefined {
    return this.residency.error;
  }

  /** Where the item of pending levels goes (see `LodOptions.manager`). */
  get manager(): LoadingManager {
    return this.residency.item.resolved;
  }
  set manager(manager: LoadingManager | undefined) {
    this.residency.item.manager = manager;
  }

  /** `levels[0]` is the source. Empty only as the target of `copy`. */
  constructor(levels: readonly LodLevel[] = [], count = 0, options: LodOptions = {}) {
    super();
    this.residency = new Residency(
      this,
      `InstancedLod ${this.uuid}`,
      this.entries,
      (level, object, context) => this.install(level, object, context),
      () => {
        this.selection?.route(this.residency.fallback, this.residency.progress < 1);
        this.dispatchEvent({ type: "levelschange" });
      },
      (error) => this.dispatchEvent({ type: "levelserror", error }),
    );
    this.residency.item.manager = options.manager;
    if (!Number.isInteger(count) || count < 0) throw new Error(`InstancedLod: count must be an integer >= 0, got ${count}`);
    this.levels = this.entries;
    this.count = count;
    this.store = new Store(count);
    this.probes = new Probes(this.store.matrices, this.extent.rest);
    const draws = levels.length > 0 ? this.build(levels) : 0;
    this.blocks = new Blocks(this.store.matrices, this.store.spheres, this.extent.source, this.bounds, draws, this.extent.rest);
  }

  private build(inputs: readonly LodLevel[]): number {
    const { extent } = this;
    inputs.forEach((input, i) => this.entries.push(new Level(input, i, this.entries)));
    estimate(this.entries, 2 * extent.measure(inputs));
    validate(this.entries);
    this.residency.reset();
    const templates = this.entries.map(({ object }, i) => (object ? parts(object, i) : []));
    this.probes.add(templates[0] ?? []);
    const draws = templates.flatMap((parts) => parts.map((part) => part.draw));
    const selection = new Selection(
      this.store.matrices,
      extent.source,
      templates.map((parts, i) => parts.length > 0 || at(inputs, i).box?.isEmpty() === false),
      draws,
      this.residency.fallback,
    );
    selection.reach.value = extent.rest.radius;
    this.selection = selection;
    this.store.attach(selection);
    const meshes = new Meshes(selection, extent.reaches, extent.drawRadius, {
      live: () => !this.disposed,
      drawn: (camera, mesh) => this.residency.drawn(camera, mesh),
      guard: (action) => this.residency.guard(action),
    });
    this.meshes = meshes;
    for (const mesh of meshes.fill(this.entries, templates)) this.add(mesh);
    return draws.length;
  }

  /** Compile only the arriving level; bounds and instance buffers stay fixed. */
  private async install(level: Level, template: Object3D, context: RenderContext): Promise<void> {
    if (!this.meshes) throw new Error("InstancedLod: missing selection");
    const loaded = await this.meshes.load(level, template, async (staged) => {
      refreshWind(this, staged);
      await compileLevel(staged, context);
    });
    if (!loaded) return;
    level.object = loaded.object;
    if (level.index === 0) this.probes.add(loaded.found);
    for (const mesh of loaded.made) this.add(mesh);
  }

  setMatrixAt(index: number, matrix: Matrix4): void {
    this.store.setMatrix(index, matrix);
  }

  getMatrixAt(index: number, matrix: Matrix4): Matrix4 {
    return this.store.getMatrix(index, matrix);
  }

  /** Tint instance `index` by `color`, as InstancedMesh.setColorAt does, in every level. */
  setColorAt(index: number, color: Color): void {
    const first = this.store.colors === null;
    this.store.setColor(index, color);
    if (first) this.meshes?.recolor();
  }

  /** Instance `index`'s colour: white unless set. */
  getColorAt(index: number, color: Color): Color {
    return this.store.getColor(index, color);
  }

  /**
   * The finest level instance `index` drew in the last update, or null before the first
   * (or at scale 0). Inside a fade the next coarser level draws too.
   */
  levelOf(index: number): number | null {
    const { last, store } = this;
    store.check(index);
    if (!this.selected) return null;
    store.measure(this.blocks);
    const height = store.height(index, last);
    if (height === null) return null;
    const level = levelAt(this.entries, height, last.forced);
    const selected = last.fades && fadeProgress(this.entries, level, height) > 0 ? level.index - 1 : level.index;
    const ready = at(this.residency.fallback, selected);
    return ready < 0 ? null : ready;
  }

  [WIND](padding: number, slope: number, baseY: number): void {
    if (this.residency.started) throw new Error("InstancedLod: apply wind before the first render");
    const sway = this.extent.wind(padding, slope, baseY);
    this.meshes?.setRadius(this.extent.drawRadius);
    this.blocks.pad(sway);
    this.blocks.refit();
    if (this.selection) this.selection.reach.value = this.extent.rest.radius * (1 + sway);
  }

  /** Sort instances for `camera`, a view or a shadow map's. What fails is reported (see `Residency.report`): three is rendering. */
  update(camera: Camera): void {
    this.residency.guard(() => this.pick(camera));
  }

  private pick(camera: Camera): void {
    if (this.disposed) return;
    const { entries, selection, meshes, residency } = this;
    if (!selection || !meshes) return;
    validate(entries);
    if (this.forceLevel !== null && !entries[this.forceLevel]) throw new Error(`Lod: forceLevel ${this.forceLevel} is not a level`);
    this.store.measure(this.blocks);
    const height = viewportHeight(camera);
    view.begin(camera, height ?? TYPICAL_HEIGHT, this.forceLevel);
    const shadow = inShadowPass(this);
    const seen = sight(shadow ? this.shadowView : this.last, view, camera, this.matrixWorld, Lod.quality, this.forceLevel);
    const drawn = this.blocks.select(entries, seen, this.extent.reaches, height !== null, this.matrixWorld);
    const progress = residency.progress;
    if (selection.progress.value !== progress) {
      selection.progress.value = progress;
      selection.changed();
    }
    this.demandLevels(camera, drawn, shadow);
    this.extent.reroute(residency.fallback, residency.previous, progress);
    // Cameras that stopped rendering it, as a clone made for one frame does, give their slots back.
    selection.forget((other) => other === camera || residency.viewing(other));
    selection.aim(camera, seen, entries);
    // Selected only when something may draw: an InstancedLod with every level hidden
    // keeps its last selection.
    meshes.schedule(meshes.show(camera, this.matrixWorld));
    residency.sync();
  }

  /**
   * Ask for the levels `drawn` for `camera`, a view's or a shadow map's: every view demands what it draws. They install
   * as they arrive, from a view's render context.
   */
  private demandLevels(camera: Camera, drawn: number[], shadow: boolean): void {
    const { entries, meshes, residency } = this;
    if (!meshes) return;
    tintLevels(entries, Lod.debug);
    if (!shadow) this.selected = true;
    // Reusable crowds can be populated and drawn in the same frame.
    const needed = this.bounds.isEmpty() ? entries.flatMap((level) => (level.object ? [level.index] : [])) : drawn;
    residency.demand(camera, needed);
    residency.update(camera, meshes.byLevel);
  }

  /**
   * Hits every instance's source level, with `instanceId` set; `object` is this
   * InstancedLod. Meshes of the source on layers the raycaster does not test are skipped.
   */
  override raycast(raycaster: Raycaster, intersects: Intersection[]): boolean {
    this.probes.raycast(this, raycaster, intersects);
    return false;
  }

  /**
   * Copies `source`'s levels, instances and settings into this empty InstancedLod of the
   * same count (it throws otherwise); the copy shares geometry and textures with `source`.
   */
  override copy(source: InstancedLod): this {
    if (this.entries.length > 0 || this.count !== source.count) throw new Error("InstancedLod.copy: copy into an empty InstancedLod of the same count");
    super.copy(source, false);
    this.store.copy(source.store);
    const draws = source.entries.length > 0 ? this.build(cloneLevels(source.entries)) : 0;
    this.blocks = new Blocks(this.store.matrices, this.store.spheres, this.extent.source, this.bounds, draws, this.extent.rest);
    this.forceLevel = source.forceLevel;
    this.autoUpdate = source.autoUpdate;
    this.residency.item.manager = source.residency.item.manager;
    copyWind(source, this);
    return this;
  }

  override clone(): this {
    // three's clone builds `new this.constructor()`, which has no count.
    const clone = new InstancedLod([], this.count).copy(this);
    if (!sameClass(this, clone)) throw new Error("InstancedLod.clone: a subclass must override clone");
    return clone;
  }

  /** Release drawables and templates only after every owner sharing their geometry, materials and textures has stopped drawing. */
  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    super.dispose();
    this.residency.dispose(() => {
      this.meshes?.dispose();
      this.selection?.dispose();
      this.store.attach(null);
      for (const { object } of this.entries) if (object) disposeCopies(object);
    });
  }
}

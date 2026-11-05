import { Object3D, Sphere, type Camera, type LoadingManager, type Intersection, type Raycaster } from "three/webgpu";
import { at } from "./at.js";
import { compileLevel } from "./compile.js";
import { measureLevels, prepareBounds } from "./bounds.js";
import { disposeCopies } from "./dispose.js";
import { setDraw, type Draw } from "./fade.js";
import { levelMaterial } from "./material.js";
import { Residency, handover, type LevelsEventMap } from "./residency.js";
import { FADE, Level, cloneLevels, estimate, fadeProgress, levelAt, demandLevels, tintLevels, validate, type LevelView, type LodLevel } from "./levels.js";
import { inShadowPass, isImpostorMesh, isLOD, isMesh, rejectSkinned } from "./three.js";
import { TYPICAL_HEIGHT, View, inView, viewportHeight, type RenderContext } from "./view.js";
import { WIND_BOUNDS } from "./wind/hooks.js";
import { copyWind, refreshWind } from "./wind/index.js";

const view = new View();

export interface LodOptions {
  /**
   * Gets an item while the levels the views need load, install, compile or fade in, ended once they are complete. Without
   * one, an owner nested in another's level reports to that owner's, any other to three's `DefaultLoadingManager`. Wait
   * for it to go idle, rendering the Scene that holds the owner a frame apart meanwhile, to capture a view complete.
   * Every camera that views the scene must then render it each frame: an owner that a whole pass of the scene's renders
   * leaves without an update (a pass ends when a camera renders the scene again) ends its item, and starts it again on
   * its next update.
   */
  manager?: LoadingManager;
}

type ObjectDraw = Extract<Draw, { kind: "object" }>;

/**
 * One object's levels, switched by on-screen height with dithered transitions.
 * The renderer updates selection before shadows; each camera uses the viewport height
 * it last rendered at (1080 until known). Orthographic views switch without fading.
 * Shadows follow selection and omit casters smaller than a shadow texel.
 *
 * Eager and deferred objects are cloned into this owner's space. A nested Lod selects
 * and fades its own levels. Lines, points and sprites draw without fading. Raycasts hit
 * the source only.
 *
 * Build a new Lod after adding or moving meshes within a level: geometry is measured
 * and hooked at construction or arrival. Skinned meshes and ShaderMaterials are
 * refused; use static meshes with node materials or supported built-in materials.
 */
export class Lod extends Object3D<LevelsEventMap> {
  /** Multiplies every measured height: below 1, cheaper levels take over sooner. */
  static quality = 1;
  /** Tint every level by its index, to see which level draws where. */
  static debug = false;
  /**
   * Share of a level's range its fade spans: from `maxPixels × (1 - fade)` up to its
   * `maxPixels`, the finer level draws too.
   */
  static readonly fade = FADE;

  readonly isLOD = true;
  /** Let the renderer call `update` with its camera every frame. */
  autoUpdate = true;
  /** Draw only this level, without fades. */
  forceLevel: number | null = null;
  readonly levels: readonly LevelView[];

  private readonly entries: Level[] = [];
  /** Per level, how its meshes draw. */
  private readonly draws: ObjectDraw[] = [];
  /** Bounding sphere of the source (see the constructor) in the Lod's own space. */
  private sphere = new Sphere();
  private casterRadius = 0;
  /**
   * Per camera, the level it settled on drawing there, kept in place of a missing level that nothing ready and coarser
   * replaces; none once it was out of that camera's view.
   */
  private readonly shown = new WeakMap<Camera, number>();
  private disposed = false;
  private readonly residency: Residency;

  get pending(): boolean {
    return this.residency.pending;
  }
  get error(): Error | undefined {
    return this.residency.error;
  }

  /**
   * `levels[0]` is the source. Empty only as the target of `copy`. A source that draws
   * nothing (an empty Object3D, for detail another system draws) is measured by the
   * first level that draws something.
   */
  constructor(levels: readonly LodLevel[] = [], options: LodOptions = {}) {
    super();
    this.residency = new Residency(
      this,
      `Lod ${this.uuid}`,
      this.entries,
      (level, object, context) => this.install(level, object, context),
      () => this.dispatchEvent({ type: "levelschange" }),
      (error) => this.dispatchEvent({ type: "levelserror", error }),
    );
    this.residency.item.manager = options.manager;
    this.levels = this.entries;
    if (levels.length > 0) this.build(levels);
  }

  /** Where the item of pending levels goes (see `LodOptions.manager`). */
  get manager(): LoadingManager {
    return this.residency.item.resolved;
  }
  set manager(manager: LoadingManager | undefined) {
    this.residency.item.manager = manager;
  }

  private build(inputs: readonly LodLevel[]): void {
    const { own, placed } = measureLevels(inputs, "Lod");
    this.sphere = placed;
    this.casterRadius = placed.radius;
    inputs.forEach((input, i) => {
      const level = new Level(input, i, this.entries);
      const draw: ObjectDraw = { kind: "object", fade: 0, diameter: 0, tint: level.tint };
      this.entries.push(level);
      this.draws.push(draw);
      const { object } = level;
      if (!object) return;
      rejectSkinned(object, "Lod");
      this.add(object);
      this.hook(object, draw, level.nested, object);
    });
    estimate(this.entries, 2 * own.radius);
    this.residency.reset();
    validate(this.entries);
  }

  /** Fade the meshes under `node` by `draw`; an inner Lod fades its own. */
  private hook(node: Object3D, draw: ObjectDraw, nested: boolean, level: Object3D): void {
    const inner = nested || (node !== level && isLOD(node));
    if (isMesh(node) && !inner) {
      setDraw(node, draw);
      // An ImpostorMesh reads its draw itself.
      if (!isImpostorMesh(node)) node.material = Array.isArray(node.material) ? node.material.map((m) => levelMaterial(m)) : levelMaterial(node.material);
    }
    for (const child of node.children) this.hook(child, draw, inner, level);
  }

  [WIND_BOUNDS](padding: number): void {
    this.casterRadius += padding;
  }

  /** Pick and fade levels for `camera`. What fails is reported (see `Residency.report`): three is rendering. */
  update(camera: Camera): void {
    this.residency.guard(() => this.pick(camera));
  }

  private pick(camera: Camera): void {
    const { entries, draws } = this;
    if (this.disposed || entries.length === 0 || inShadowPass(this)) return;
    validate(entries);
    view.begin(camera, viewportHeight(camera) ?? TYPICAL_HEIGHT, this.forceLevel);
    tintLevels(entries, Lod.debug);
    const height = view.pixels(this.matrixWorld, this.sphere) * Lod.quality;
    const desired = levelAt(entries, height, this.forceLevel);
    this.residency.demand(
      camera,
      demandLevels(entries, height, this.forceLevel).map(({ index }) => index),
    );
    this.residency.update(camera);
    const { fallback, previous } = this.residency;
    const neighbour = Math.max(0, desired.index - 1);
    const seen = inView(camera, this.matrixWorld, this.sphere);
    const kept = seen ? (this.shown.get(camera) ?? -1) : -1;
    let level = at(fallback, desired.index);
    let finer = at(fallback, neighbour);
    if (level < 0) level = finer = kept;
    const fade = view.fades ? fadeProgress(entries, desired, height) : 0;
    let t = level === finer ? 0 : fade;
    const progress = this.residency.progress;
    if (progress < 1) {
      let before = at(previous, desired.index);
      let beforeFiner = at(previous, neighbour);
      if (before < 0) before = beforeFiner = kept;
      // A level that replaced nothing draws at once.
      if (before >= 0) [level, finer, t] = handover([before, beforeFiner, before === beforeFiner ? 0 : fade], [level, finer, t], progress);
    } else this.shown.set(camera, seen ? level : -1);
    const diameter = 2 * this.casterRadius * this.matrixWorld.getMaxScaleOnAxis();
    entries.forEach((each, i) => {
      const draw = at(draws, i);
      draw.fade = i === level ? t : i === finer ? -t : 0;
      draw.diameter = diameter;
      if (each.object) each.object.visible = i === level || (t > 0 && i === finer);
    });
    this.residency.sync();
  }

  private async install(level: Level, template: Object3D, context: RenderContext): Promise<void> {
    const object = template.clone();
    const nested = isLOD(object);
    object.visible = false;
    rejectSkinned(object, "Lod");
    if (level.box) prepareBounds(object, level.box);
    this.hook(object, at(this.draws, level.index), nested, object);
    // Parented hidden only for world matrices and wind; the level arrives after compiling.
    this.add(object);
    object.updateWorldMatrix(true, true);
    refreshWind(this, object);
    try {
      await compileLevel(object, context);
    } catch (error) {
      this.remove(object);
      disposeCopies(object);
      throw error;
    }
    if (this.disposed) {
      this.remove(object);
      disposeCopies(object);
      return;
    }
    level.object = object;
    level.nested = nested;
  }

  override raycast(raycaster: Raycaster, intersects: Intersection[]): boolean {
    const source = this.entries[0];
    if (source?.object) raycaster.intersectObject(source.object, true, intersects);
    // Stop the raycaster from descending into the other levels.
    return false;
  }

  /**
   * Copies `source`'s levels into this empty Lod (it throws otherwise). The copies share
   * geometry, materials and textures with `source`, as three's clone does; the Lod
   * settings, manager and each level's `maxPixels` come along.
   */
  override copy(source: Lod): this {
    if (this.entries.length > 0) throw new Error("Lod.copy: copy into an empty Lod");
    super.copy(source, false);
    if (source.entries.length > 0) this.build(cloneLevels(source.entries));
    this.forceLevel = source.forceLevel;
    this.autoUpdate = source.autoUpdate;
    this.residency.item.manager = source.residency.item.manager;
    copyWind(source, this);
    return this;
  }

  /** Release drawables and templates only after every owner sharing their geometry, materials and textures has stopped drawing. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.residency.dispose(() => {
      for (const { object } of this.entries) if (object) disposeCopies(object);
    });
  }
}

import { Object3D, Sphere, type Camera, type Intersection, type Raycaster } from "three/webgpu";
import { compileLevel } from "./queue.js";
import { measureLevels, prepareBounds } from "./bounds.js";
import { disposeTree } from "./dispose.js";
import { setDraw, type Draw } from "./fade.js";
import { levelMaterial } from "./material.js";
import { Residency, handover, type LevelsEventMap } from "./residency.js";
import { FADE, Level, cloneLevels, estimate, fadeProgress, levelAt, demandLevels, tintLevels, validate, type LodLevel } from "./levels.js";
import { inShadowPass, isImpostorMesh, isLOD, isMesh, rejectSkinned } from "./three.js";
import { TYPICAL_HEIGHT, View, viewportHeight, watchViewport, watchContext, unwatchContext, inView, type RenderContext } from "./view.js";
import { WIND_BOUNDS } from "./wind/hooks.js";
import { copyWind, refreshWind } from "./wind/index.js";

const view = new View();

type ObjectDraw = Extract<Draw, { kind: "object" }>;

/**
 * One object's levels, switched by on-screen height with dithered transitions.
 * The renderer updates selection before shadows; each camera uses its last drawn
 * viewport height (1080 until known). Orthographic views switch without fading.
 * Shadows follow selection and omit casters smaller than a shadow texel.
 *
 * Eager and deferred objects are cloned into this owner's space. A nested Lod selects
 * and fades its own levels. Lines, points and sprites draw without fading or reporting
 * viewport height. Raycasts hit the source only.
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
  readonly levels: readonly Level[];

  private readonly entries: Level[] = [];
  /** Per level, how its meshes draw. */
  private readonly draws: ObjectDraw[] = [];
  /** Bounding sphere of the source (see the constructor) in the Lod's own space. */
  private sphere = new Sphere();
  private casterRadius = 0;
  private disposed = false;
  private readonly residency = new Residency(
    this.entries,
    (level, object, context) => this.install(level, object, context),
    () => this.dispatchEvent({ type: "levelschange" }),
    (error) => this.dispatchEvent({ type: "levelserror", error }),
  );

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
  constructor(levels: readonly LodLevel[] = []) {
    super();
    this.levels = this.entries;
    if (levels.length > 0) this.build(levels);
  }

  private build(inputs: readonly LodLevel[]): void {
    const { own, placed } = measureLevels(inputs, "Lod");
    this.sphere = placed;
    this.casterRadius = placed.radius;
    let drawable = false;
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
      object.traverseVisible((node) => {
        drawable ||= isMesh(node);
      });
    });
    estimate(this.entries, 2 * own.radius);
    this.residency.reset();
    validate(this.entries);
    if (!drawable) watchContext(this);
  }

  /** Fade the meshes under `node` by `draw` and learn the viewport height from them; an inner Lod fades its own. */
  private hook(node: Object3D, draw: ObjectDraw, nested: boolean, level: Object3D): void {
    const inner = nested || (node !== level && isLOD(node));
    if (isMesh(node)) {
      if (!inner) {
        setDraw(node, draw);
        // An ImpostorMesh reads its draw itself.
        if (!isImpostorMesh(node)) node.material = Array.isArray(node.material) ? node.material.map((m) => levelMaterial(m)) : levelMaterial(node.material);
      }
      watchViewport(node);
    }
    for (const child of node.children) this.hook(child, draw, inner, level);
  }

  [WIND_BOUNDS](padding: number): void {
    this.casterRadius += padding;
  }

  /** Pick and fade levels for `camera`; detail starts after a draw supplies its render context. */
  update(camera: Camera): void {
    const { entries, draws } = this;
    if (this.disposed || entries.length === 0 || inShadowPass(this)) return;
    validate(entries);
    view.begin(camera, viewportHeight(camera) ?? TYPICAL_HEIGHT, this.forceLevel);
    tintLevels(entries, Lod.debug);
    const height = view.pixels(this.matrixWorld, this.sphere) * Lod.quality;
    const desired = levelAt(entries, height, this.forceLevel);
    this.residency.demand(
      camera,
      inView(camera, this.matrixWorld, this.sphere) ? demandLevels(entries, height, this.forceLevel).map(({ index }) => index) : [],
    );
    this.residency.update(camera);
    const { fallback, previous } = this.residency;
    const neighbour = Math.max(0, desired.index - 1);
    let level = at(fallback, desired.index);
    let finer = at(fallback, neighbour);
    const fade = view.fades ? fadeProgress(entries, desired, height) : 0;
    let t = level === finer ? 0 : fade;
    const progress = this.residency.progress;
    if (progress < 1) {
      const before = at(previous, desired.index),
        beforeFiner = at(previous, neighbour);
      [level, finer, t] = handover([before, beforeFiner, before === beforeFiner ? 0 : fade], [level, finer, t], progress);
    }
    const diameter = 2 * this.casterRadius * this.matrixWorld.getMaxScaleOnAxis();
    entries.forEach((each, i) => {
      const draw = draws[i];
      if (!draw) throw new Error("Lod: a level has no draw");
      draw.fade = i === level ? t : i === finer ? -t : 0;
      draw.diameter = diameter;
      if (each.object) each.object.visible = i === level || (t > 0 && i === finer);
    });
  }

  private async install(level: Level, template: Object3D, context: RenderContext): Promise<void> {
    const object = template.clone();
    level.object = object;
    level.nested = isLOD(object);
    object.visible = false;
    rejectSkinned(object, "Lod");
    if (level.box) prepareBounds(object, level.box);
    this.hook(object, at(this.draws, level.index), level.nested, object);
    this.add(object);
    object.updateWorldMatrix(true, true);
    refreshWind(this, object);
    await compileLevel(object, context);
    let drawable = false;
    object.traverse((node) => {
      drawable ||= isMesh(node);
    });
    if (!this.disposed && drawable) unwatchContext(this);
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
   * settings and each level's `maxPixels` come along.
   */
  override copy(source: Lod): this {
    if (this.entries.length > 0) throw new Error("Lod.copy: copy into an empty Lod");
    super.copy(source, false);
    if (source.entries.length > 0) this.build(cloneLevels(source.entries));
    this.forceLevel = source.forceLevel;
    this.autoUpdate = source.autoUpdate;
    copyWind(source, this);
    return this;
  }

  /** Release drawables and templates only after every owner sharing their geometry, materials and textures has stopped drawing. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    unwatchContext(this);
    this.residency.dispose(() => {
      for (const { object } of this.entries) if (object) disposeTree(object);
    });
  }
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Lod: missing index ${index}`);
  return value;
}

import { Object3D, Sphere, type Camera, type Intersection, type LoadingManager, type Raycaster, type Renderer } from "three/webgpu";
import { at } from "./at.js";
import { measureLevels, prepareBounds } from "./levels/bounds.js";
import { disposeCopies } from "./dispose.js";
import { EncodedLevels, emptyLevels, levelsFrom, tintOf, type LodLevel, type ThresholdedLevel } from "./levels/index.js";
import { FADE, drawnLevel, levelsToDraw } from "./levels/draw.js";
import { setFadeSource, type FadeSource } from "./levels/fade.js";
import { levelsToLoad } from "./levels/load.js";
import { LodLevelLoadManager, type LodEventMap, type PreparedLevel } from "./levels/manager.js";
import { levelMaterial } from "./levels/material.js";
import { screenHeight, screenOf } from "./levels/screen.js";
import { inShadowMap, renderers } from "./levels/renderer.js";
import { isImpostorMesh, isLOD, isLine, isMesh, isPoints, rejectSkinned, sameClass } from "./three.js";
import { WIND } from "./wind/hooks.js";
import { copyWind, refreshWind } from "./wind/index.js";

export interface LodOptions {
  /**
   * Gets an item while levels a camera needs load, compile or fade in, ended once they are complete. Without one, a
   * Lod nested in another's level reports to that one's, any other to three's `DefaultLoadingManager`. Wait for a
   * quiet frame, one in which no item started or ended, rendering (or compiling) the Scene that holds the Lod a frame
   * apart meanwhile, to capture what a camera sees complete. A Lod its renderer rendered around for a frame without
   * updating it ends its item, and its next update starts it again. Renders of other scenes in a separate task can end
   * the item early, and the next update reopens it; a renderer that only compiles leaves a hidden Lod's item held.
   */
  manager?: LoadingManager;
}

type ObjectFade = Extract<FadeSource, { kind: "object" }>;

/**
 * One object's levels, switched by on-screen height with dithered fades. three's renderer calls `update` with each
 * camera before it draws, shadow maps' included; each camera measures at the height it draws at, measured in each
 * render (outside one, the canvas's). Orthographic cameras switch without fading. Shadows follow what the camera draws
 * and omit casters smaller than a shadow texel; levels cast into three's shadow maps, not into a light whose shadow
 * map a custom shadow node replaces. Nothing draws until the coarsest level that draws something has loaded, which
 * loads first; a deferred level loads when a camera first needs it, once that one has loaded, and meanwhile the
 * nearest loaded coarser level draws in its place.
 *
 * Arriving levels' texture uploads are paced to about one uncompressed 2048² RGBA texture's bytes per frame. Levels
 * are cloned into the Lod. A nested Lod switches and fades its own levels. Lines, points and sprites draw without
 * fading. Raycasts hit the source only. A Lod draws with one renderer: the first of `Lod.renderers` that renders it.
 *
 * Build a new Lod after adding or moving meshes within a level: geometry is measured and hooked at construction or
 * arrival. Skinned meshes and ShaderMaterials are refused; use static meshes with node materials or supported built-in
 * materials.
 */
export class Lod extends Object3D<LodEventMap> {
  /** Multiplies every measured height: below 1, cheaper levels take over sooner. */
  static quality = 1;
  /** Tint every level by its index, to see which level draws where. */
  static debug = false;
  /** Share of a level's range its fade spans: from `maxPixels × (1 - fade)` up to its `maxPixels`, the finer level draws too. */
  static readonly fade = FADE;
  /**
   * The renderers Lods and InstancedLods draw with, as three tells a LOD's `update` no renderer: add the app's before
   * it renders them; a bake adds its own while it runs. Each Lod or InstancedLod draws with the first of them that
   * renders it, and another of them drawing it is its error. Until one has, an update draws and loads nothing.
   */
  static readonly renderers: Set<Renderer> = renderers;

  readonly isLOD = true;
  /** Let the renderer call `update` with its camera every frame. */
  autoUpdate = true;
  /** Draw only this level, without fades, once the coarsest level that draws something has loaded. */
  forceLevel: number | null = null;
  /** The levels, each `object` this Lod's own copy once there is one. Set `maxPixels` to move a switch. */
  readonly levels: ThresholdedLevel[] = [];

  /** The levels as they were given, which a copy is made from. */
  private inputs: readonly LodLevel[] = [];
  /** Per level, where its meshes' fade comes from. */
  private readonly fades: ObjectFade[] = [];
  /** Per level, whether its object is a Lod, which fades its own levels. */
  private readonly nested: boolean[] = [];
  /**
   * Per loaded level, what in it may cast (see `shadowCasters`): found when it is built or joins, read every shadow
   * map.
   */
  private readonly casters: (Object3D[] | null)[] = [];
  /** The levels as levelsToDraw reads them. */
  private encoded: EncodedLevels;
  /** Bounding sphere of the source (see `measureLevels`) in the Lod's own space. */
  private sphere = new Sphere();
  private casterRadius = 0;
  private loads: LodLevelLoadManager;
  private disposed = false;

  /**
   * `levels[0]` is the source. Empty only as the target of `copy`. A source that draws nothing (an empty Object3D, for
   * detail another system draws) is measured by the first level that draws something.
   */
  constructor(levels: readonly LodLevel[], options: LodOptions = {}) {
    super();
    const { loads, encoded } = this.build(levels);
    this.loads = loads;
    this.encoded = encoded;
    this.loads.item.given = options.manager;
  }

  private build(inputs: readonly LodLevel[]): { loads: LodLevelLoadManager; encoded: EncodedLevels } {
    this.inputs = inputs;
    if (inputs.length > 0) {
      const { own, placed } = measureLevels(inputs, "Lod");
      this.sphere = placed;
      this.casterRadius = placed.radius;
      this.levels.push(...levelsFrom(inputs, 2 * own.radius, "Lod"));
    }
    const encoded = new EncodedLevels(this.levels, emptyLevels(inputs), "Lod");
    this.levels.forEach(({ object }, i) => {
      const fade: ObjectFade = { kind: "object", fade: 0, diameter: 0, tint: tintOf(i, false) };
      this.fades.push(fade);
      this.nested.push(object ? isLOD(object) : false);
      this.casters.push(object ? shadowCasters(object) : null);
      if (!object) return;
      rejectSkinned(object, "Lod");
      this.add(object);
      this.hook(object, fade, isLOD(object), object);
    });
    const loads = new LodLevelLoadManager(
      this,
      `Lod ${this.uuid}`,
      inputs,
      encoded.get(null, true),
      (level, loaded) => this.prepare(level, loaded),
      (level) => {
        const object = this.levels[level]?.object;
        return object ? [object] : [];
      },
      null,
    );
    return { loads, encoded };
  }

  /** Fade the meshes under `node` by `fade`; an inner Lod fades its own. */
  private hook(node: Object3D, fade: ObjectFade, nested: boolean, level: Object3D): void {
    const inner = nested || (node !== level && isLOD(node));
    if (isMesh(node) && !inner) {
      setFadeSource(node, fade);
      // An ImpostorMesh reads its draw itself.
      if (!isImpostorMesh(node)) node.material = Array.isArray(node.material) ? node.material.map((m) => levelMaterial(m)) : levelMaterial(node.material);
    }
    for (const child of node.children) this.hook(child, fade, inner, level);
  }

  /** A copy of `loaded`, level `index`'s object, parented hidden for world matrices and wind until it joins. */
  private prepare(index: number, loaded: Object3D): PreparedLevel {
    const object = loaded.clone();
    const nested = isLOD(object);
    const level = at(this.levels, index);
    object.visible = false;
    rejectSkinned(object, "Lod");
    if (level.box) prepareBounds(object, level.box);
    this.hook(object, at(this.fades, index), nested, object);
    this.add(object);
    object.updateWorldMatrix(true, true);
    refreshWind(this, object);
    return {
      object,
      join: () => {
        level.object = object;
        this.nested[index] = nested;
        this.casters[index] = shadowCasters(object);
      },
      discard: () => {
        this.remove(object);
        disposeCopies(object);
      },
    };
  }

  get pending(): boolean {
    return this.loads.pending;
  }

  get error(): Error | undefined {
    return this.loads.error;
  }

  /** Where the item of levels a camera misses goes (see `LodOptions.manager`). */
  get manager(): LoadingManager {
    return this.loads.item.manager;
  }
  set manager(manager: LoadingManager | undefined) {
    this.loads.item.given = manager;
  }

  /** Switch and fade the levels for `camera`, and load those it needs. What fails is reported (see `error`): three is rendering. */
  update(camera: Camera): void {
    // A shadow map draws nothing of a Lod whose levels cast nothing; one not loaded yet may.
    const shadow = inShadowMap(this);
    if (shadow && !this.casters.some((casters) => !casters || casters.some((node) => node.castShadow))) return;
    this.loads.guard(() => this.show(camera, shadow));
  }

  /** Show the levels for `camera`, a shadow map's when `shadow`. */
  private show(camera: Camera, shadow: boolean): void {
    if (this.disposed || this.levels.length === 0) return;
    const renderer = this.loads.bind();
    if (!renderer) return;
    // A shadow map draws the levels its scene's camera chose.
    if (shadow) return void this.loads.request(camera, 0, true);
    const { height, levels } = this.measure(camera, renderer, false);
    const loaded = this.loads.request(camera, levelsToLoad([[height, height]], this.encoded.heights(levels)), false);
    let { level, finer, fade } = levelsToDraw(height, levels, loaded, this.loads.before, this.loads.progress);
    // A nested Lod fades its own levels: the switch to or from one is immediate.
    if (this.nested[level] || this.nested[finer]) fade = 0;
    const diameter = 2 * this.casterRadius * this.matrixWorld.getMaxScaleOnAxis();
    this.levels.forEach(({ object }, i) => {
      const source = at(this.fades, i);
      source.fade = i === level ? fade : i === finer ? -fade : 0;
      source.diameter = diameter;
      source.tint = tintOf(i, Lod.debug);
      if (object) object.visible = i === level || (fade > 0 && i === finer);
    });
  }

  /** The source's height on `camera`'s screen, drawn by `renderer`, and the levels as levelsToDraw reads them there. */
  private measure(camera: Camera, renderer: Renderer, shadow: boolean) {
    const screen = screenOf(camera, this.loads.heightOf(camera, renderer, shadow));
    const height = screenHeight(this.sphere, this.matrixWorld, screen) * Lod.quality;
    return { height, levels: this.encoded.get(this.forceLevel, !screen.ortho) };
  }

  /**
   * The index of the level that draws most of the Lod's pixels for `camera` from where it is, with the levels loaded
   * now and no arrival under way (see `drawnLevel`); null while no level it could draw is loaded. It measures with the
   * renderer drawing the Lod, so it throws before one has rendered it.
   */
  getLevel(camera: Camera): number | null {
    if (this.levels.length === 0) return null;
    const { renderer } = this.loads;
    if (!renderer) throw new Error("Lod.getLevel: render the Lod first: it measures with the renderer drawing it");
    const { height, levels } = this.measure(camera, renderer, inShadowMap(this));
    return drawnLevel(levelsToDraw(height, levels, this.loads.loaded, this.loads.loaded, 1));
  }

  [WIND](padding: number): void {
    if (this.loads.started) throw new Error("Lod: apply wind before the first render");
    this.casterRadius += padding;
  }

  override raycast(raycaster: Raycaster, intersects: Intersection[]): boolean {
    const source = this.levels[0]?.object;
    if (source) raycaster.intersectObject(source, true, intersects);
    // Stop the raycaster from descending into the other levels.
    return false;
  }

  /**
   * Copies `source`'s levels into this empty Lod (it throws otherwise). The copies share geometry, materials and
   * textures with `source`, as three's clone does; the settings, LoadingManager, wind and each level's `maxPixels`
   * come along.
   */
  override copy(source: Lod): this {
    if (this.levels.length > 0) throw new Error("Lod.copy: copy into an empty Lod");
    super.copy(source, false);
    const { loads, encoded } = this.build(source.inputs.map((input, i) => ({ ...input, maxPixels: at(source.levels, i).maxPixels })));
    this.loads = loads;
    this.encoded = encoded;
    this.loads.item.given = source.loads.item.given;
    this.forceLevel = source.forceLevel;
    this.autoUpdate = source.autoUpdate;
    copyWind(source, this);
    return this;
  }

  override clone(): this {
    const clone = new Lod([]).copy(this);
    if (!sameClass(this, clone)) throw new Error("Lod.clone: a subclass must override clone");
    return clone;
  }

  /**
   * Release what the Lod made of its levels, once nothing it prepares or compiles still uses them. Objects you give or
   * load are yours to dispose; LodLoader's are freed when the last Lod holding them is disposed (see `LodLevel.hold`).
   */
  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    super.dispose();
    void this.loads.dispose(() => {
      for (const { object } of this.levels) if (object) disposeCopies(object);
    });
  }
}

/**
 * What three's shadow pass may draw under `root`, itself included: its meshes, lines and points, cast if `castShadow`
 * is set.
 */
function shadowCasters(root: Object3D): Object3D[] {
  const found: Object3D[] = [];
  root.traverse((node) => {
    if (isMesh(node) || isLine(node) || isPoints(node)) found.push(node);
  });
  return found;
}

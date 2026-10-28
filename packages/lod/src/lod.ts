import { Object3D, Sphere, type Camera, type Intersection, type Raycaster } from "three/webgpu";
import { measureLevels } from "./bounds.js";
import { disposeTree } from "./dispose.js";
import { setDraw, type Draw } from "./fade.js";
import { levelMaterial } from "./material.js";
import { available, fallbacks, inView, type LevelsEventMap } from "./lazy.js";
import { FADE, Level, cloneLevels, copyThresholds, estimate, fadeProgress, levelAt, tintLevels, validate, type LodLevel } from "./levels.js";
import { inShadowPass, isLazyImpostor, isImpostorMesh, isLOD, isMesh, rejectSkinned } from "./three.js";
import { TYPICAL_HEIGHT, View, viewportHeight, watchViewport } from "./view.js";
import { WIND_BOUNDS } from "./wind/hooks.js";
import { copyWind, refreshWind } from "./wind/index.js";

const view = new View();

type ObjectDraw = Extract<Draw, { kind: "object" }>;

/**
 * Levels of detail of one object, switched by its height on screen. Level 0 is the
 * source; each further level is used while the object is at most its `maxPixels` tall
 * (see `LodLevel.maxPixels` for the defaults). Near a switch both neighbours draw and
 * split the pixels with a dither, so nothing pops; elsewhere exactly one level is visible
 * and the others are hidden. Shadows follow the camera's choice and fade with it; nothing
 * of the object is drawn into a directional light's shadow map whose texels are wider
 * than the whole object: it could cover a texel only by chance.
 *
 * three's renderer calls `update(camera)` while it lists the scene (as for its own LOD),
 * before shadow maps render; the calls its shadow passes make are ignored. The height
 * uses the viewport the camera last drew one of the levels' meshes in, in CSS pixels
 * (1080 before that), so several views each get their own. An orthographic camera has
 * no distance to dither by: levels switch by on-screen size there too, but at once.
 *
 * Levels are children of the Lod in its space, any Object3D: meshes, an ImpostorMesh, a
 * group, another Lod. Each mesh draws with a faded copy of its material, which every Lod
 * drawing that material shares. Lines, points and sprites are drawn but neither fade nor
 * tell the Lod the viewport height. A nested Lod hands over to its neighbours at once.
 * Raycasts hit the source only.
 *
 * Levels are read when the Lod is built: meshes added to a level later, or moved within
 * it, are neither faded nor measured right. Build a new Lod instead.
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
  readonly levels: readonly LodLevel[];

  private readonly entries: Level[] = [];
  /** Per level, how its meshes draw. */
  private readonly draws: ObjectDraw[] = [];
  /** Bounding sphere of the source (see the constructor) in the Lod's own space. */
  private sphere = new Sphere();
  private casterRadius = 0;
  private disposed = false;
  private readonly installed = new Set<Object3D>();
  private fallback: number[] = [];

  /**
   * `levels[0]` is the source. Empty only as the target of `copy`. A source that draws
   * nothing (an empty Object3D, for detail another system draws) is measured by the
   * first level that draws something.
   */
  constructor(levels: Object3D[] = []) {
    super();
    this.levels = this.entries;
    if (levels.length > 0) this.build(levels);
  }

  private build(objects: Object3D[]): void {
    const [source] = objects;
    if (!source) throw new Error("Lod: needs at least the source level");
    if (isLazyImpostor(source)) throw new Error("Lod: the source level must be eager");
    for (const object of objects)
      if (isLazyImpostor(object)) {
        object.materialize();
      }
    for (const object of objects) rejectSkinned(object, "Lod");
    const { own, placed } = measureLevels(objects, "Lod");
    this.sphere = placed;
    this.casterRadius = placed.radius;
    this.add(...objects);
    objects.forEach((object, i) => {
      const level = new Level(object, i, isLOD(object), this.entries);
      const draw: ObjectDraw = { kind: "object", fade: 0, diameter: 0, tint: level.tint };
      this.entries.push(level);
      this.draws.push(draw);
      this.hook(object, draw, level.nested, object);
      if (available(object)) this.installed.add(object);
    });
    estimate(this.entries, 2 * own.radius);
    this.fallback = fallbacks(objects);
    validate(this.entries);
    for (const object of objects) if (isLazyImpostor(object)) object.retain();
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

  /** Pick and fade levels for `camera`; three's renderer calls this itself while `autoUpdate`. */
  update(camera: Camera): void {
    const { entries, draws } = this;
    if (this.disposed || entries.length === 0 || inShadowPass(this)) return;
    let changed = false;
    if (this.installed.size < entries.length)
      entries.forEach((entry, i) => {
        if (!isLazyImpostor(entry.object) || this.installed.has(entry.object)) return;
        entry.object.materialize();
        if (!available(entry.object)) return;
        const draw = draws[i];
        if (!draw) throw new Error("Lod: missing lazy draw");
        this.hook(entry.object, draw, false, entry.object);
        this.installed.add(entry.object);
        changed = true;
      });
    if (changed) {
      this.fallback = fallbacks(entries.map((entry) => entry.object));
      refreshWind(this);
      this.updateWorldMatrix(true, true);
      this.dispatchEvent({ type: "levelschange" });
    }
    validate(entries);
    view.begin(camera, viewportHeight(camera) ?? TYPICAL_HEIGHT, this.forceLevel);
    tintLevels(entries, Lod.debug);
    const height = view.pixels(this.matrixWorld, this.sphere) * Lod.quality;
    const desired = levelAt(entries, height, this.forceLevel);
    if (isLazyImpostor(desired.object) && desired.object.status === "idle" && inView(camera, this.matrixWorld, this.sphere)) desired.object.request();
    const fallback = this.fallback;
    const level = entries[fallback[desired.index] ?? 0];
    let t = view.fades ? fadeProgress(entries, desired, height) : 0;
    const neighbour = t > 0 ? entries[desired.index - 1]?.object : undefined;
    if (neighbour && isLazyImpostor(neighbour) && neighbour.status === "idle" && inView(camera, this.matrixWorld, this.sphere)) neighbour.request();
    const finer = t > 0 ? entries[fallback[desired.index - 1] ?? 0] : undefined;
    if (level === finer) t = 0;
    const diameter = 2 * this.casterRadius * this.matrixWorld.getMaxScaleOnAxis();
    entries.forEach((each, i) => {
      const draw = draws[i];
      if (!draw) throw new Error("Lod: a level has no draw");
      draw.fade = each === level ? t : each === finer ? -t : 0;
      draw.diameter = diameter;
      each.object.visible = each === level || (t > 0 && each === finer);
    });
  }

  override raycast(raycaster: Raycaster, intersects: Intersection[]): boolean {
    const source = this.entries[0];
    if (source) raycaster.intersectObject(source.object, true, intersects);
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
    copyThresholds(source.entries, this.entries);
    this.forceLevel = source.forceLevel;
    this.autoUpdate = source.autoUpdate;
    copyWind(source, this);
    return this;
  }

  /**
   * Frees every level, the source included: geometries, materials and their textures.
   * Clones share them, so dispose a Lod only once no clone draws any more.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { object } of this.entries) isLazyImpostor(object) ? object.release() : disposeTree(object);
  }
}

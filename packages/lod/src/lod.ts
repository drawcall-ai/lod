import { Object3D, Sphere, type Camera, type Intersection, type Matrix4, type Raycaster } from "three";
import { measureLevels } from "./bounds.js";
import { disposeTree } from "./dispose.js";
import { fadeMesh, writeFades } from "./fade.js";
import { FADE, Level, cloneLevels, copyThresholds, estimate, fadingWith, levelAt, validate, type LodLevel } from "./levels.js";
import { skipTinyShadows } from "./shadow.js";
import { isImpostorMesh, isLOD, isMesh, rejectSkinned } from "./three.js";
import { View, Viewports } from "./view.js";

const view = new View();

/**
 * Levels of detail of one object, switched by its height on screen. Level 0 is the
 * source; each further level is used while the object is at most its `maxPixels` tall
 * (see `LodLevel.maxPixels` for the defaults). Near a switch both neighbours draw and
 * split the pixels with a dither, so nothing pops; elsewhere exactly one level is visible
 * and the others are hidden, which also keeps them out of shadow maps: shadows follow the
 * camera's choice. Nothing of it is drawn into a directional light's shadow map whose
 * texels are wider than the whole object: it could cover a texel only by chance.
 *
 * three's WebGLRenderer calls `update(camera)` while it lists the scene (as for its own
 * LOD), before shadow maps render. The height uses the viewport the camera last drew one
 * of the levels' meshes in, in CSS pixels (1080 before that), so several views each get
 * their own.
 *
 * Fades are measured from the viewing camera in every pass. In shadow passes, which are
 * often orthographic, an impostor's shadow dithers with it and a mesh's shadow is whole,
 * so both cast while fading. An orthographic viewing camera has no distance to dither
 * by: levels switch by on-screen size there too, but at once.
 *
 * Levels are children of the Lod in its space, any Object3D: meshes, an ImpostorMesh, a
 * group, another Lod. Each mesh draws with its own faded copy of its material; the
 * copies of one material share a compiled program. Lines, points and sprites are drawn
 * but neither fade nor tell the Lod the viewport height. A nested Lod hands over to its
 * neighbours here at once. Raycasts hit the source only.
 *
 * Levels are read when the Lod is built: meshes added to a level later, or moved within
 * it, are neither faded nor measured right. Build a new Lod instead.
 */
export class Lod extends Object3D {
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
  /** Bounding sphere of the source (see the constructor) in the Lod's own space. */
  private sphere = new Sphere();
  private readonly viewports = new Viewports();

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
    for (const object of objects) rejectSkinned(object, "Lod");
    const { own, placed } = measureLevels(objects, "Lod");
    this.sphere = placed;
    this.add(...objects);
    this.updateWorldMatrix(true, true);
    const inverse = this.matrixWorld.clone().invert();
    objects.forEach((object, i) => {
      const level = new Level(object, i, isLOD(object), this.entries);
      this.entries.push(level);
      this.hook(object, level, level.nested, inverse);
    });
    estimate(this.entries, 2 * own.radius);
    validate(this.entries);
  }

  /**
   * Fade the meshes under `node` by `level` and keep them out of shadow maps too coarse
   * for the whole object, and learn the viewport height from all of them. An inner Lod
   * and an ImpostorMesh (which measures its instances) do their own shadow check.
   */
  private hook(node: Object3D, level: Level, nested: boolean, inverse: Matrix4): void {
    const inner = nested || (node !== level.object && isLOD(node));
    if (isMesh(node)) {
      if (!inner) fadeMesh(node, level, this.sphere, inverse.clone().multiply(node.matrixWorld));
      if (!inner && !isImpostorMesh(node)) skipTinyShadows(node, () => 2 * this.sphere.radius * this.matrixWorld.getMaxScaleOnAxis());
      this.viewports.watch(node);
    }
    for (const child of node.children) this.hook(child, level, inner, inverse);
  }

  /** Pick and fade levels for `camera`; three's renderer calls this itself while `autoUpdate`. */
  update(camera: Camera): void {
    const { entries } = this;
    if (entries.length === 0) return;
    validate(entries);
    view.begin(camera, this.viewports.heightOf(camera), this.forceLevel);
    writeFades(entries, view, Lod.quality, Lod.debug);
    const height = view.pixels(this.matrixWorld, this.sphere) * Lod.quality;
    const level = levelAt(entries, height, this.forceLevel);
    const finer = fadingWith(entries, level, height, view.fades);
    for (const each of entries) each.object.visible = each === level || each === finer;
  }

  override raycast(raycaster: Raycaster, intersects: Intersection[]): boolean {
    const source = this.entries[0];
    if (source) raycaster.intersectObject(source.object, true, intersects);
    // Stop the raycaster from descending into the other levels.
    return false;
  }

  /**
   * Copies `source`'s levels into this empty Lod (it throws otherwise). The copies share
   * geometry and textures with `source`, as three's clone does, and get their own faded
   * materials; the Lod settings and each level's `maxPixels` come along.
   */
  override copy(source: Lod): this {
    if (this.entries.length > 0) throw new Error("Lod.copy: copy into an empty Lod");
    super.copy(source, false);
    if (source.entries.length > 0) this.build(cloneLevels(source.entries));
    copyThresholds(source.entries, this.entries);
    this.forceLevel = source.forceLevel;
    this.autoUpdate = source.autoUpdate;
    return this;
  }

  /**
   * Frees every level, the source included: geometries, materials and their textures.
   * Clones share geometry and textures, so dispose a Lod only once no clone draws any more.
   */
  dispose(): void {
    for (const { object } of this.entries) disposeTree(object);
  }
}

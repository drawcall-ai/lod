import {
  Box3,
  Color,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Object3D,
  Sphere,
  type Camera,
  type Intersection,
  type LoadingManager,
  type Raycaster,
  type Renderer,
} from "three/webgpu";
import { at } from "./at.js";
import { disposeCopies } from "./dispose.js";
import { EncodedLevels, emptyLevels, levelsFrom, type LodLevel, type ThresholdedLevel } from "./levels/index.js";
import { FADE } from "./levels/draw.js";
import { fadeSourceOf, type DrawnInstances } from "./levels/fade.js";
import { levelsToLoad } from "./levels/load.js";
import { LodLevelLoadManager, type LodEventMap } from "./levels/manager.js";
import { inShadowMap, maxStorageBinding } from "./levels/renderer.js";
import { isRenderer, isStorageInstanced, sameClass } from "./three.js";
import { WIND } from "./wind/hooks.js";
import { copyWind } from "./wind/index.js";
import { localCamera, shownBy, type LocalCamera } from "./instanced/camera.js";
import { ClusterView, boundClusters, checkClusters, measuredBox, type LodCluster } from "./instanced/clusters.js";
import { cullIn, emptyCull, type CullDistance } from "./instanced/cull.js";
import { Instances, measure } from "./instanced/instances.js";
import { MeshesByLevel, type Drawing } from "./instanced/levels.js";
import { InstanceLists, frustumIn, listedOf } from "./instanced/lists.js";
import { MAX_SURVIVOR_SCALE, instanceLevel } from "./instanced/measure.js";
import { drawInstances } from "./instanced/meshes.js";
import { raycastInstances } from "./instanced/raycast.js";
import { InstanceShape } from "./instanced/shape.js";

/** How a Lod is made. */
export interface LodOptions {
  /**
   * Gets an item while levels a camera needs load, compile or fade in, ended once they are complete; three's
   * `DefaultLoadingManager` without one. Wait for a quiet frame, one in which no item started or ended, rendering (or
   * compiling) the Scene that holds the Lod a frame apart meanwhile, to capture what a camera sees complete. A Lod its
   * renderer rendered around for a frame without updating it ends its item, and its next update starts it again.
   * Renders of other scenes in a separate task can end the item early, and the next update reopens it; a renderer that
   * only compiles leaves a hidden Lod's item held.
   */
  manager?: LoadingManager;
}

/**
 * Copies of one object at levels of detail, driven like a three InstancedMesh: `instanceMatrix`, `instanceColor`,
 * `count` and `boundingBox`, and `clusters` to cull and choose levels by. Each copy draws the level levelsToDraw gives
 * for its height on screen, switching with dithered fades; each camera's instances are sorted into indirect draws on
 * the GPU. `new Lod(levels)` is one object at the Lod's own transform.
 *
 * The attributes are assignable. A CPU attribute's edits draw once its `needsUpdate` is set (within its update ranges,
 * which the Lod takes and clears), as an InstancedMesh's do. A StorageInstancedBufferAttribute, such as one the app's
 * compute pass writes, is read in place, every frame; a storage colour holds four floats per instance. A matrix of
 * scale 0 draws nothing. Instance matrices may scale arbitrarily; the Lod's own transform and its parents should scale
 * uniformly.
 *
 * Which levels load and which level meshes draw for a camera follow from the instances' bounds: per cluster, its box
 * and scales; without clusters, `boundingBox` around the first `count` instances, else what the CPU measures of a CPU
 * instanceMatrix. With clusters, only their instances draw. A storage instanceMatrix with neither loads every level
 * (it warns once). Each camera draws only the instances in its frustum, and each shadow map is a camera of its own: it
 * draws the casters in its frustum, each at the level its texels resolve, as an orthographic camera would (an instance
 * smaller than a texel casts nothing). Thresholds, fades and loading follow `LodLevel`; `cullDistance` thins the
 * instances out with distance. Nothing draws until the coarsest level that draws something has loaded, which loads
 * first; a deferred level loads when a camera first needs it, and meanwhile the nearest loaded coarser level draws in
 * its place. Arriving levels' texture uploads are paced to about one uncompressed 2048² RGBA texture's bytes per frame.
 *
 * It draws with WebGPU only (three's WebGPURenderer on its WebGPU backend, with `indirect-first-instance`), with the
 * first renderer that draws it: it learns of it in that renderer's first frame, which draws nothing of it, and another
 * renderer drawing it is its error. Sequential cameras are supported; a nested render with a camera that the outer
 * render also draws with replaces that camera's instance lists, so exclude the Lod from it with camera layers.
 *
 * Level templates are cloned, then their meshes are instanced, as children of the Lod on its layers; it sets each
 * one's `visible` per camera, so hide the Lod itself, never its level meshes. Skinned meshes, InstancedMeshes (except ImpostorMesh),
 * lines, points, sprites and LODs in levels are refused, as are ShaderMaterials; use static meshes with node materials
 * or supported built-in materials. Build a new Lod after adding or moving meshes within a level: geometry is measured
 * at construction or arrival. For external detail, leave level 0 empty and draw the instances that `getLevelAt`
 * reports there.
 */
export class Lod extends Object3D<LodEventMap> {
  /** Multiplies every measured height: below 1, cheaper levels take over sooner. */
  static quality = 1;
  /** Tint every level by its index, to see which level draws where. */
  static debug = false;
  /** Share of a level's range its fade spans: from `maxPixels × (1 - fade)` up to its `maxPixels`, the finer level draws too. */
  static readonly fade = FADE;

  readonly isLOD = true;
  readonly isLod = true;
  /** Let the renderer call `update` with its camera every frame. */
  autoUpdate = true;
  /** Draw only this level, without fades, once the coarsest level that draws something has loaded. */
  forceLevel: number | null = null;
  /** The levels, each `object` the template its level meshes are made from, once there is one (never in the scene). */
  readonly levels: ThresholdedLevel[] = [];
  /** Thins the instances out with distance from a camera, in every camera; null draws them at any distance. */
  cullDistance: CullDistance | null = null;
  /** 16 floats per instance: a CPU InstancedBufferAttribute (identities to start with) or a storage one. */
  instanceMatrix: InstancedBufferAttribute;
  /** RGB per instance, white without: three floats on the CPU, four in a storage attribute. */
  instanceColor: InstancedBufferAttribute | null = null;
  /** How many of `instanceMatrix`'s instances draw. */
  count: number;
  /** Bounds every instance at every level, in the Lod's space (see `computeBoundingBox`); measured when null. */
  boundingBox: Box3 | null = null;
  /** Disjoint ranges of instances, each inside its box, which cull and choose levels apart; clipped to `count`. */
  clusters: LodCluster[] | undefined = undefined;

  /** The levels as they were given, which a copy is made from. */
  private inputs: readonly LodLevel[] = [];
  /** What it is made of for its levels, which a copy makes anew. */
  private built: Built;
  private disposed = false;
  private readonly instances = new Instances();
  /** What the level meshes draw. */
  private readonly drawn: DrawnInstances;
  /** Around every instance, survivors grown: what every level mesh is culled and boxed by. */
  private readonly bounds = { sphere: new Sphere(), box: new Box3() };
  private readonly view = new ClusterView();
  /** The cluster ranges last checked to be disjoint. */
  private readonly checked: number[] = [];
  /** What `cullIn` writes cullDistance into, in this Lod's space. */
  private readonly cull = emptyCull();
  /**
   * Drawn until a renderer has drawn the Lod, to learn which: three tells a mesh its renderer, but not a LOD. It bounds
   * the instances for Box3.setFromObject, as the level meshes do once there are some.
   */
  private readonly sentinel: Mesh<InstancedBufferGeometry>;
  private warned = false;

  /** `levels[0]` is the source; empty only as the target of `copy`. `count` instances, at the Lod's origin to start with. */
  constructor(levels: readonly LodLevel[], count = 1, options: LodOptions = {}) {
    super();
    if (!Number.isInteger(count) || count < 0) throw new RangeError(`Lod: count must be a nonnegative integer, not ${count}`);
    this.count = count;
    this.instanceMatrix = identities(count);
    this.instances.refresh(this);
    this.drawn = { matrices: this.instances.matrixStorage, colors: this.instances.colorStorage };
    this.sentinel = this.makeSentinel();
    this.built = this.init(levels);
    this.built.loads.item.given = options.manager;
    this.refresh();
  }

  get pending(): boolean {
    return this.built.loads.pending;
  }

  get error(): Error | undefined {
    return this.built.loads.error;
  }

  /** Where the item of levels a camera misses goes (see `LodOptions.manager`). */
  get manager(): LoadingManager {
    return this.built.loads.item.manager;
  }
  set manager(manager: LoadingManager | undefined) {
    this.built.loads.item.given = manager;
  }

  setMatrixAt(index: number, matrix: Matrix4): this {
    matrix.toArray(this.instanceMatrix.array, index * 16);
    return this;
  }

  getMatrixAt(index: number, matrix: Matrix4): Matrix4 {
    return matrix.fromArray(this.instanceMatrix.array, index * 16);
  }

  /** Write instance `index`'s colour, making a white `instanceColor` for every instance first if there is none. */
  setColorAt(index: number, color: Color): this {
    this.instanceColor ??= new InstancedBufferAttribute(new Float32Array(this.instanceMatrix.count * 3).fill(1), 3);
    color.toArray(this.instanceColor.array, index * this.instanceColor.itemSize);
    return this;
  }

  /** Instance `index`'s colour: white without `instanceColor`. */
  getColorAt(index: number, color: Color): Color {
    const colors = this.instanceColor;
    return colors ? color.fromArray(colors.array, index * colors.itemSize) : color.setRGB(1, 1, 1);
  }

  /**
   * Set `boundingBox` around the first `count` instances at every level and its sway, from a CPU instanceMatrix as it
   * is now; the CPU cannot read a storage one.
   */
  computeBoundingBox(): void {
    if (isStorageInstanced(this.instanceMatrix))
      throw new Error("Lod.computeBoundingBox: the CPU cannot read a storage instanceMatrix: set boundingBox or clusters");
    this.boundingBox = measuredBox(measure(this.instanceMatrix, this.count, null), this.built.shape, this.boundingBox ?? new Box3());
  }

  /** What this Lod is made of for `inputs`: its levels, their meshes and their loading. */
  private init(inputs: readonly LodLevel[]): Built {
    const shape = new InstanceShape(inputs);
    const lists = new InstanceLists(listedOf(inputs));
    const drawing = { shape, lists, drawn: this.drawn };
    this.inputs = inputs;
    if (inputs.length > 0) this.levels.push(...levelsFrom(inputs, 2 * shape.ownRadius, "Lod"));
    const encoded = new EncodedLevels(this.levels, emptyLevels(inputs), "Lod");
    const drawFor = (renderer: unknown, camera: Camera) =>
      this.built.loads.guard(() => {
        this.built.lists.drawFor(this.see(renderer), camera, this.instances.matrixStorage);
      });
    const meshes = new MeshesByLevel(this, this.levels, drawing, this.bounds, drawFor);
    // Its sorts show them.
    meshes.show(0);
    const loads = new LodLevelLoadManager(
      this,
      `Lod ${this.uuid}`,
      inputs,
      encoded.get(null, true),
      (level, loaded) => meshes.prepare(level, loaded),
      (level) => meshes.of(level),
    );
    return { ...drawing, meshes, loads, encoded };
  }

  /**
   * The sentinel, drawn until a renderer has drawn the Lod (see `see`): no instances, on the Lod's layers, casting, and
   * never hit by a raycast. Its box is the instances' bounds, and its vertices that box's corners (see `placeSentinel`),
   * which precise Box3.setFromObject reads.
   */
  private makeSentinel(): Mesh<InstancedBufferGeometry> {
    const geometry = new InstancedBufferGeometry().setAttribute("position", new Float32BufferAttribute(new Float32Array(24), 3));
    geometry.instanceCount = 0;
    geometry.boundingBox = this.bounds.box;
    geometry.boundingSphere = this.bounds.sphere;
    const sentinel = new Mesh(geometry, SENTINEL_MATERIAL);
    sentinel.frustumCulled = false;
    sentinel.layers = this.layers;
    sentinel.raycast = () => {};
    // Shadow passes draw it too: a Lod that only casts learns its renderer there.
    sentinel.castShadow = true;
    sentinel.onBeforeRender = (renderer) => this.built.loads.guard(() => void this.see(renderer));
    this.add(sentinel);
    return sentinel;
  }

  /** `renderer`, which three hands a mesh's draw, draws the Lod (see `LodLevelLoadManager.see`): it, once checked. */
  private see(renderer: unknown): Renderer {
    if (!isRenderer(renderer)) throw new Error("Lod: three drew a mesh of it with no renderer");
    this.built.loads.see(renderer);
    return renderer;
  }

  [WIND](padding: number, slope: number, baseY: number): void {
    if (this.built.loads.started) throw new Error("Lod: apply wind before the first render");
    this.built.shape.wind(padding, slope, baseY);
    for (const mesh of this.built.meshes.all()) {
      const source = fadeSourceOf(mesh);
      if (source) source.radius = this.built.shape.fadeRadius;
    }
    this.refresh();
  }

  /** Take in the instances as they are now, so that its level meshes bound them (see Box3.setFromObject), then update the world matrices. */
  override updateMatrixWorld(force?: boolean): void {
    if (!this.disposed && this.levels.length > 0) this.built.loads.guard(() => this.refresh());
    super.updateMatrixWorld(force);
  }

  /** Sort the instances into level lists for `camera`, a camera's or a shadow map's, and load the levels they need. What fails is reported (see `error`). */
  update(camera: Camera): void {
    if (this.disposed || this.levels.length === 0) return;
    // A shadow map draws nothing of a Lod whose levels cast nothing; one not loaded yet may.
    const shadow = inShadowMap(this);
    if (shadow && !this.levels.some(({ object }, i) => !object || this.built.meshes.of(i).some((mesh) => mesh.castShadow))) return;
    this.built.loads.guard(() => {
      const { renderer } = this.built.loads;
      this.sentinel.visible = renderer === null;
      if (renderer) this.sort(renderer, camera, shadow);
    });
  }

  /** Take in the attributes, clusters and cullDistance as they are now, and bound the instances. */
  private refresh(): void {
    const { lists, meshes, shape } = this.built;
    if (this.clusters) checkClusters(this.clusters, this.instanceMatrix.count, this.checked);
    this.instances.refresh(this);
    const survivors = this.cullDistance?.scaleSurvivors ?? false;
    const matrices = survivors ? lists.scaledMatrices(this.instanceMatrix.count) : this.instances.matrixStorage;
    const colors = this.instances.colorStorage;
    if (matrices !== this.drawn.matrices || colors !== this.drawn.colors) {
      this.drawn.matrices = matrices;
      this.drawn.colors = colors;
      drawInstances(meshes.all(), this.drawn);
    }
    boundClusters(this, this.instances.measured, shape, survivors ? MAX_SURVIVOR_SCALE : 1, this.bounds);
    this.placeSentinel();
  }

  /** Put the sentinel's vertices at the corners of the instances' bounds; at the origin while nothing bounds them. */
  private placeSentinel(): void {
    const { box } = this.bounds;
    const position = this.sentinel.geometry.getAttribute("position");
    const empty = box.isEmpty();
    let moved = false;
    for (let i = 0; i < 8; i++) {
      const x = empty ? 0 : i & 1 ? box.max.x : box.min.x;
      const y = empty ? 0 : i & 2 ? box.max.y : box.min.y;
      const z = empty ? 0 : i & 4 ? box.max.z : box.min.z;
      if (position.getX(i) === x && position.getY(i) === y && position.getZ(i) === z) continue;
      position.setXYZ(i, x, y, z);
      moved = true;
    }
    if (moved) position.needsUpdate = true;
  }

  /** Sort for `camera`, a shadow map's when `shadow`, drawn by `renderer`. */
  private sort(renderer: Renderer, camera: Camera, shadow: boolean): void {
    const { loads, shape, lists, encoded, meshes } = this.built;
    this.refresh();
    const limit = maxStorageBinding(renderer);
    const bytes = this.instanceMatrix.count * 64;
    if (bytes > limit)
      throw new RangeError(
        `Lod: its instanceMatrix of ${this.instanceMatrix.count} instances takes ${bytes} bytes, more than the device's storage binding of ${limit} bytes: split the instances across Lods, or raise maxStorageBufferBindingSize in the renderer's requiredLimits`,
      );
    const local = this.localCamera(camera, renderer, shadow);
    const cull = cullIn(this.cullDistance, this.matrixWorld, this.cull);
    const found = lists.of(camera);
    const { view } = this;
    view.see(this, this.instances.measured, shape, frustumIn(found, camera, this.matrixWorld), local, cull);
    if (view.unbounded && !this.warned) {
      this.warned = true;
      console.warn(`Lod ${this.uuid}: nothing bounds its storage instanceMatrix, so every level loads and the CPU culls nothing; set boundingBox or clusters`);
    }
    const { levels } = local;
    // A shadow map draws from the levels its scene's cameras loaded.
    loads.request(camera, levelsToLoad(shadow ? [] : view.heights, encoded.heights(levels)), shadow);
    meshes.tint(Lod.debug);
    lists.prune(camera, (other) => loads.rendering(other));
    const { loaded, before, progress } = loads;
    // Three projects this Lod's children for the camera after this update.
    const { shown, only } = shownBy(view.seen, levels, encoded, { loaded, before, progress });
    lists.sort(
      camera,
      {
        ...local,
        cull,
        loaded,
        before,
        progress,
        source: shape.source,
        reach: shape.reach,
        ranges: view.ranges,
        instances: view.instances,
        inside: view.inside,
        onlyLevel: cull === null ? only : 0,
        version: this.instances.version,
      },
      limit,
    );
    // Nothing draws from the camera's indirect draws before a sort writes them, which a level mesh's draw runs first.
    meshes.show(found.written ? shown : 0);
  }

  /** `camera` in this Lod's space, drawn by `renderer` (see `localCamera`). */
  private localCamera(camera: Camera, renderer: Renderer, shadow: boolean): LocalCamera {
    const { loads, encoded } = this.built;
    return localCamera(camera, loads.heightOf(camera, renderer, shadow), this.matrixWorld, encoded, this.forceLevel, Lod.quality);
  }

  /**
   * The level that draws most of instance `index`'s pixels for `camera` from where it is now, with the levels loaded
   * now and no arrival under way (see `drawnLevel`); null at scale 0, thinned out by `cullDistance`, or while no level
   * it could draw is loaded. From the CPU instanceMatrix as it is, edits not yet drawn included; the CPU cannot read a
   * storage one. It measures with the renderer drawing the Lod, so it throws before one has drawn it.
   */
  getLevelAt(index: number, camera: Camera): number | null {
    const { renderer } = this.built.loads;
    if (!renderer) throw new Error("Lod.getLevelAt: render the Lod first: it measures with the renderer drawing it");
    if (isStorageInstanced(this.instanceMatrix)) throw new Error("Lod.getLevelAt: the CPU cannot read a storage instanceMatrix");
    if (!Number.isInteger(index) || index < 0 || index >= this.count)
      throw new RangeError(`Lod.getLevelAt: ${index} is not one of its ${this.count} instances`);
    const cull = cullIn(this.cullDistance, this.matrixWorld, this.cull);
    const local = this.localCamera(camera, renderer, inShadowMap(this));
    return instanceLevel(this.instanceMatrix.array, index * 16, cull, local, this.built.shape.source, this.built.loads.loaded);
  }

  /**
   * Hits the first `count` instances on the source level, with `instanceId` set as on an InstancedMesh's hits; `object`
   * is this Lod. Instances of a storage instanceMatrix, which the CPU cannot read, are not hit. Its level meshes, on its
   * layers, are never hit themselves.
   */
  override raycast(raycaster: Raycaster, intersects: Intersection[]): boolean {
    if (!isStorageInstanced(this.instanceMatrix))
      raycastInstances(this, { parts: this.built.meshes.source, rest: this.built.shape.rest }, this.instanceMatrix.array, this.count, raycaster, intersects);
    // Stop the raycaster from descending into the level meshes.
    return false;
  }

  /**
   * Copies `source`'s levels, instances and settings into this Lod without levels (it throws otherwise); the copy
   * shares geometry and textures with `source`, and holds copies of its attributes and clusters. Storage attributes
   * cannot be copied: their instances live on the GPU.
   */
  override copy(source: Lod): this {
    if (this.levels.length > 0) throw new Error("Lod.copy: copy into a Lod without levels");
    const { instanceMatrix, instanceColor } = source;
    if (isStorageInstanced(instanceMatrix) || (instanceColor && isStorageInstanced(instanceColor)))
      throw new Error("Lod.copy: a storage attribute's instances live on the GPU and cannot be copied");
    const inputs = source.inputs.map((input, i) => ({ ...input, maxPixels: at(source.levels, i).maxPixels }));
    super.copy(source, false);
    this.instanceMatrix = new InstancedBufferAttribute(instanceMatrix.array.slice(), 16);
    this.instanceColor = instanceColor && new InstancedBufferAttribute(instanceColor.array.slice(), 3);
    this.count = source.count;
    this.boundingBox = source.boundingBox?.clone() ?? null;
    this.clusters = source.clusters?.map((cluster) => ({ ...cluster, boundingBox: cluster.boundingBox.clone() }));
    this.cullDistance = source.cullDistance && { ...source.cullDistance };
    this.forceLevel = source.forceLevel;
    this.autoUpdate = source.autoUpdate;
    this.built.lists.dispose();
    this.built.loads.dispose(() => {});
    this.built = this.init(inputs);
    this.built.loads.item.given = source.built.loads.item.given;
    copyWind(source, this);
    this.refresh();
    return this;
  }

  override clone(): this {
    const clone = new Lod([], 0).copy(this);
    if (!sameClass(this, clone)) throw new Error("Lod.clone: a subclass must override clone");
    return clone;
  }

  /**
   * Release its buffers and what it made of its levels, once nothing it prepares or compiles still uses them. Objects
   * you give or load, its attributes among them, are yours to dispose; CachedLodLoader's are freed when the last Lod
   * holding them is disposed (see `LodLevel.hold`).
   */
  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    super.dispose();
    this.sentinel.removeFromParent();
    this.sentinel.geometry.dispose();
    this.built.loads.dispose(() => {
      this.built.meshes.dispose();
      this.built.lists.dispose();
      this.instances.dispose();
      for (const { object } of this.levels) if (object) disposeCopies(object);
    });
  }
}

/** What a Lod is made of for its levels: what its meshes draw with, and its loading. */
interface Built extends Drawing {
  readonly meshes: MeshesByLevel;
  readonly loads: LodLevelLoadManager;
  /** The levels as levelsToDraw reads them. */
  readonly encoded: EncodedLevels;
}

const SENTINEL_MATERIAL = new MeshBasicNodeMaterial();

/** A CPU instanceMatrix of `count` identities. */
function identities(count: number): InstancedBufferAttribute {
  const array = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) array.set(IDENTITY, i * 16);
  return new InstancedBufferAttribute(array, 16);
}

const IDENTITY = new Matrix4().elements;

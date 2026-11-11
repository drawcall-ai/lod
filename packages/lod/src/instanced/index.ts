import { Box3, Object3D, Sphere, type Camera, type Intersection, type LoadingManager, type Mesh, type Raycaster, type Renderer } from "three/webgpu";
import { at } from "../at.js";
import { disposeCopies } from "../dispose.js";
import { EncodedLevels, emptyLevels, levelsFrom, type LodLevel, type ThresholdedLevel } from "../levels/index.js";
import { fadeSourceOf } from "../levels/fade.js";
import { levelsToLoad } from "../levels/load.js";
import { LodLevelLoadManager, type LodEventMap } from "../levels/manager.js";
import type { LodPool } from "../pool.js";
import { Lod, type LodOptions } from "../lod.js";
import { inShadowMap } from "../levels/renderer.js";
import { sameClass } from "../three.js";
import { WIND } from "../wind/hooks.js";
import { copyWind } from "../wind/index.js";
import type { InstancedLodChunk, InstancedLodChunkParameters } from "./chunk.js";
import { ChunkSet } from "./chunks.js";
import { cullIn, emptyCull, type CullDistance } from "./cull.js";
import { MeshesByLevel, type Drawing } from "./levels.js";
import { InstanceLists, frustumIn, listedOf } from "./lists.js";
import { localCamera, shownBy, walk, type LocalCamera } from "./camera.js";
import { drawInstances } from "./meshes.js";
import { raycastInstances } from "./raycast.js";
import { InstanceShape } from "./shape.js";
import { MAX_SURVIVOR_SCALE, instanceLevel } from "./measure.js";

/** The meshes drawing an InstancedLod's level, which its sorts show: what a bake draws of it is level 0's. */
export const LEVEL_MESHES = Symbol("levelMeshes");
/** Put an InstancedLod no render has updated in another LodPool, as a bake does with its copy (see `bakeCopy`). */
export const REPOOL = Symbol("repool");

/** How an InstancedLod is made. */
export interface InstancedLodOptions extends LodOptions {
  /**
   * The most instances it draws for a camera, over all its chunks, CPU and GPU chunks alike: 16384 by default. Its
   * lists take 8 bytes per level that draws something per instance (about 400 KB with the defaults and three levels),
   * and every camera that draws any InstancedLod of its LodPool, each shadow map's included, holds the lists of every
   * InstancedLod of that LodPool. A camera that draws only a few InstancedLods, such as a minimap's or a reflection's,
   * is bounded by giving those a LodPool of their own. Chunks that together outgrow it are reported (see `error`),
   * naming it as the limit to raise. Its LodPool holds the instances themselves (see `LodPoolOptions`).
   */
  maxInstanceCount?: number;
}

const DEFAULT_INSTANCES = 16384;

/**
 * Independently drawn copies of one object, sorted into indirect draws per camera on the GPU. Instances arrive and
 * leave in chunks (see `addChunk`), from the CPU or written by the app's GPU passes; `cullDistance` thins them out with
 * distance. Thresholds, fades, loading and global settings follow Lod: each instance draws what levelsToDraw gives for
 * its height. Each camera draws only the instances in its frustum, and each shadow map is a camera of its own: it draws
 * the casters in its frustum, each at the level its texels resolve, as an orthographic camera would (an instance
 * smaller than a texel casts nothing). Instance matrices may scale arbitrarily; the InstancedLod's own transform and its
 * parents should scale uniformly. Scale 0 draws nothing.
 *
 * Level templates are cloned, then their meshes are instanced; it sets each level mesh's `visible` per camera, so hide
 * the InstancedLod itself, never its level meshes, and show none of them yourself: one drawn before the InstancedLod's
 * first render draws nothing and is its error. Skinned meshes, InstancedMeshes (except ImpostorMesh)
 * and nested Lods are unsupported. For external detail, leave level 0 empty and draw the instances that
 * `chunk.getLevelAt` reports there.
 *
 * Every level mesh's `geometry.boundingBox` and `boundingSphere` bound all its instances, not one, so
 * `new Box3().setFromObject(lod)` bounds them once a level has loaded; with `precise` it walks a level's vertices once,
 * at no instance, as it cannot see them. Measure one instance by a level's `object`, scaled by its matrix.
 *
 * Instances live in its LodPool, and every InstancedLod of a LodPool sorts for a camera in one compute call. It draws
 * with the first renderer of `Lod.renderers` that renders it (see `Lod.renderers`), as does every InstancedLod of its
 * LodPool. Requires WebGPU `indirect-first-instance`. Sequential cameras are supported; a nested render with a camera that the
 * outer render also draws with replaces that camera's instance lists, so exclude this InstancedLod from it with camera
 * layers.
 */
export class InstancedLod extends Object3D<LodEventMap> {
  readonly isLOD = true;
  readonly isInstancedLod = true;
  /** Let the renderer call `update` with its camera every frame. */
  autoUpdate = true;
  /** Draw only this level, without fades, once the coarsest level that draws something has loaded. */
  forceLevel: number | null = null;
  /** The levels, each `object` the template its level meshes are made from, once there is one (never in the scene). */
  readonly levels: ThresholdedLevel[] = [];
  /** Thins the instances out with distance from a camera, in every camera; null draws them at any distance. */
  cullDistance: CullDistance | null = null;

  /** The levels as they were given, which a copy is made from. */
  private inputs: readonly LodLevel[] = [];
  /** What it is made of for its levels and sizes, which a copy makes anew. */
  private built: Built;
  private disposed = false;
  /** Around every instance, survivors grown: what every level mesh is culled and boxed by. */
  private readonly bounds = { sphere: new Sphere(), box: new Box3() };
  /** What `cullIn` writes cullDistance into, in this InstancedLod's space. */
  private readonly cull = emptyCull();

  /**
   * `levels[0]` is the source. Empty only as the target of `copy`. It holds no instances until chunks are added. `pool`
   * holds its instances, and those of the InstancedLods it sorts with.
   */
  constructor(
    levels: readonly LodLevel[],
    private pool: LodPool,
    options: InstancedLodOptions = {},
  ) {
    super();
    if (pool.disposed) throw new Error("LodPool: disposed");
    const maxInstanceCount = options.maxInstanceCount ?? DEFAULT_INSTANCES;
    if (!Number.isInteger(maxInstanceCount) || maxInstanceCount < 1)
      throw new RangeError(`InstancedLod: maxInstanceCount must be a positive integer, got ${maxInstanceCount}`);
    this.built = this.init(levels, maxInstanceCount);
    this.built.loads.item.given = options.manager;
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

  /** Its chunks, in the order they were added. */
  get chunks(): Iterable<InstancedLodChunk> {
    return this.built.chunks.keys();
  }

  /** What this InstancedLod is made of for `inputs` and `maxInstanceCount`: its levels, their meshes and their loading. */
  private init(inputs: readonly LodLevel[], maxInstanceCount: number): Built {
    const shape = new InstanceShape(inputs);
    const lists = new InstanceLists(listedOf(inputs), maxInstanceCount);
    const chunks = new ChunkSet(
      this.bounds,
      () => shape.originReach,
      (chunk, index, camera) => this.levelAt(chunk, index, camera),
    );
    const { pages } = this.pool;
    const drawn = { matrices: pages.matrices, colors: pages.colors };
    const drawing = { shape, lists, drawn };
    this.inputs = inputs;
    if (inputs.length > 0) this.levels.push(...levelsFrom(inputs, 2 * shape.ownRadius, "InstancedLod"));
    const encoded = new EncodedLevels(this.levels, emptyLevels(inputs), "InstancedLod");
    const drawFor = (renderer: unknown, camera: Camera) =>
      this.built.loads.guard(() => {
        const bound = this.built.loads.renderer;
        if (!bound) throw new Error("InstancedLod: a level mesh drew before its first render; its level meshes' `visible` is the InstancedLod's to set");
        if (renderer !== bound) throw new Error("InstancedLod: another renderer than the first that rendered it drew it");
        lists.drawFor(bound, camera);
      });
    const meshes = new MeshesByLevel(this, this.levels, drawing, this.bounds, drawFor);
    // Its sorts show them.
    meshes.show(0);
    const loads = new LodLevelLoadManager(
      this,
      `InstancedLod ${this.uuid}`,
      inputs,
      encoded.get(null, true),
      (level, loaded) => meshes.prepare(level, loaded),
      (level) => meshes.of(level),
      async () => {
        const { renderer } = this.built.loads;
        if (!renderer) return false;
        const instances = await this.pool.pages.status(renderer, chunks.slots());
        if (instances !== null && instances > maxInstanceCount)
          throw new Error(`InstancedLod: its chunks hold ${instances} instances, more than its lists hold: raise its maxInstanceCount (${maxInstanceCount})`);
        return instances !== null;
      },
    );
    return { maxInstanceCount, chunks, ...drawing, meshes, loads, encoded };
  }

  /**
   * Add `parameters`' instances as one chunk, from the CPU or the GPU (see `InstancedLodChunkParameters`). The next
   * render that updates this InstancedLod copies them into its pages. Its item (see `LodOptions.manager`) stays held
   * until the GPU shows every chunk copied; a chunk the pool lacks pages for draws the instances it got until it is
   * removed, and is this InstancedLod's error (see `error`).
   */
  addChunk(parameters: InstancedLodChunkParameters): InstancedLodChunk {
    if (this.disposed) throw new Error("InstancedLod: it was disposed");
    if (this.levels.length === 0) throw new Error("InstancedLod: give it levels before chunks");
    const chunk = this.built.chunks.add(parameters);
    this.measureBounds();
    this.built.loads.chunksChanged();
    return chunk;
  }

  /** Remove `chunk`'s instances; its pages return to the pool in the next render. */
  removeChunk(chunk: InstancedLodChunk): void {
    this.built.chunks.remove(chunk);
    this.measureBounds();
    this.built.loads.chunksChanged();
  }

  /** Bound every chunk's instances, survivors grown. */
  private measureBounds(): void {
    this.built.chunks.bound(this.cullDistance?.scaleSurvivors ? MAX_SURVIVOR_SCALE : 1);
  }

  [LEVEL_MESHES](level: number): readonly Mesh[] {
    return this.built.meshes.of(level);
  }

  [REPOOL](pool: LodPool): void {
    if (this.built.loads.renderer) throw new Error("InstancedLod: a render has updated it: it draws with its LodPool");
    this.pool = pool;
    this.built.drawn.matrices = pool.pages.matrices;
    this.built.drawn.colors = pool.pages.colors;
    drawInstances(this.built.meshes.all(), this.built.drawn);
  }

  [WIND](padding: number, slope: number, baseY: number): void {
    if (this.built.loads.started) throw new Error("InstancedLod: apply wind before the first render");
    this.built.shape.wind(padding, slope, baseY);
    for (const mesh of this.built.meshes.all()) {
      const source = fadeSourceOf(mesh);
      if (source?.kind === "instances") source.radius = this.built.shape.fadeRadius;
    }
    this.measureBounds();
  }

  /** Sort the instances into level lists for `camera`, a camera's or a shadow map's, and load the levels they need. What fails is reported (see `error`). */
  update(camera: Camera): void {
    if (this.disposed || this.levels.length === 0) return;
    // A shadow map draws nothing of an InstancedLod whose levels cast nothing; one not loaded yet may.
    const shadow = inShadowMap(this);
    if (shadow && !this.levels.some(({ object }, i) => !object || this.built.meshes.of(i).some((mesh) => mesh.castShadow))) return;
    this.built.loads.guard(() => {
      const renderer = this.built.loads.bind();
      if (renderer) this.sort(renderer, camera, shadow);
    });
  }

  /** Sort for `camera`, a shadow map's when `shadow`, drawn by `renderer`. */
  private sort(renderer: Renderer, camera: Camera, shadow: boolean): void {
    const { loads, shape, lists, chunks, drawn, encoded, meshes } = this.built;
    this.pool.bind(renderer);
    const { pages, sorter } = this.pool;
    const { levels, eye, scale, ortho } = this.localCamera(camera, renderer, shadow);
    if (chunks.refresh()) this.measureBounds();
    // The pages change before any sorts with them.
    chunks.take(pages, lists.register(sorter));
    pages.prepare(renderer);
    const survivors = this.cullDistance?.scaleSurvivors ?? false;
    if (survivors !== (drawn.matrices !== pages.matrices)) this.scaleSurvivors(survivors);
    const cull = cullIn(this.cullDistance, this.matrixWorld, this.cull);
    const local = { levels, eye, scale, ortho, cull };
    const found = lists.of(camera);
    // Outside the camera's frustum, nothing draws: a shadow map, which loads nothing by heights, walks no chunk then.
    const seen = frustumIn(found, camera, this.matrixWorld).intersectsSphere(this.bounds.sphere);
    if (!shadow || seen) walk(found, local, this.built);
    // A shadow map draws from the levels its scene's cameras loaded.
    loads.request(camera, shadow ? levelsToLoad([], encoded.heights(levels)) : found.wanted, shadow);
    meshes.tint(Lod.debug);
    lists.prune(camera, (other) => loads.rendering(other));
    const { loaded, before, progress } = loads;
    // Three projects this InstancedLod's children for the camera after this update.
    const shown = seen ? shownBy(found, levels, encoded, { loaded, before, progress }) : 0;
    lists.sort(camera, {
      ...local,
      loaded,
      before,
      progress,
      bounds: this.bounds.sphere,
      box: this.bounds.box,
      source: shape.source,
      reach: shape.reach,
      onlyLevel: cull === null ? found.onlyLevel : 0,
      chunks: chunks.version,
    });
    // Nothing draws from the camera's indirect draws before a sort writes them, which a level mesh's draw runs first.
    meshes.show(found.written ? shown : 0);
  }

  /** `camera` in this InstancedLod's space, drawn by `renderer` (see `localCamera`). */
  private localCamera(camera: Camera, renderer: Renderer, shadow: boolean): LocalCamera {
    const { loads, encoded } = this.built;
    return localCamera(camera, loads.heightOf(camera, renderer, shadow), this.matrixWorld, encoded, this.forceLevel);
  }

  /** Draw survivors' scaled matrices, or the pool's again. */
  private scaleSurvivors(survivors: boolean): void {
    const { pages, sorter } = this.pool;
    this.built.drawn.matrices = survivors ? sorter.scaledMatrices : pages.matrices;
    drawInstances(this.built.meshes.all(), this.built.drawn);
    this.measureBounds();
  }

  /** The level instance `index` of `chunk` draws most of its pixels with for `camera` (see `InstancedLodChunk.getLevelAt`). */
  private levelAt(chunk: InstancedLodChunk, index: number, camera: Camera): number | null {
    const { renderer } = this.built.loads;
    if (!renderer) throw new Error("InstancedLodChunk.getLevelAt: render the InstancedLod first: it measures with the renderer drawing it");
    const cull = cullIn(this.cullDistance, this.matrixWorld, this.cull);
    const local = this.localCamera(camera, renderer, inShadowMap(this));
    return instanceLevel(chunk.instanceMatrix.array, (chunk.start + index) * 16, cull, local, this.built.shape.source, this.built.loads.loaded);
  }

  /**
   * Hits every instance of its CPU chunks on the source level, with `instanceId` and `chunk` set (see
   * `InstancedLodIntersection`); `object` is this InstancedLod. A GPU chunk's instances the CPU cannot see, and meshes
   * of the source on layers the raycaster does not test, are not hit.
   */
  override raycast(raycaster: Raycaster, intersects: Intersection[]): boolean {
    raycastInstances(this, { parts: this.built.meshes.source, rest: this.built.shape.rest }, this.built.chunks.cpu(), raycaster, intersects);
    return false;
  }

  /**
   * Copies `source`'s levels, CPU chunks and settings into this empty InstancedLod, one without levels or chunks (it
   * throws otherwise); the copy shares geometry and textures with `source`, and its chunks hold copies of the source's
   * attributes. A GPU chunk cannot be copied: its instances live on the GPU.
   */
  override copy(source: InstancedLod): this {
    if (this.levels.length > 0 || this.built.chunks.size > 0) throw new Error("InstancedLod.copy: copy into an InstancedLod without levels or chunks");
    const chunks = source.built.chunks.copies();
    const inputs = source.inputs.map((input, i) => ({ ...input, maxPixels: at(source.levels, i).maxPixels }));
    super.copy(source, false);
    this.built.chunks.dispose();
    this.built.lists.dispose();
    this.built = this.init(inputs, source.built.maxInstanceCount);
    this.built.loads.item.given = source.built.loads.item.given;
    this.forceLevel = source.forceLevel;
    this.autoUpdate = source.autoUpdate;
    this.cullDistance = source.cullDistance && { ...source.cullDistance };
    copyWind(source, this);
    for (const chunk of chunks) this.addChunk(chunk);
    return this;
  }

  override clone(): this {
    const clone = new InstancedLod([], this.pool).copy(this);
    if (!sameClass(this, clone)) throw new Error("InstancedLod.clone: a subclass must override clone");
    return clone;
  }

  /**
   * Release its buffers and what it made of its levels, once nothing it prepares or compiles still uses them. Objects
   * you give or load, chunk attributes among them, are yours to dispose; LodLoader's are freed when the last Lod
   * holding them is disposed (see `LodLevel.hold`).
   */
  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    super.dispose();
    this.built.chunks.dispose();
    this.built.loads.dispose(() => {
      this.built.meshes.dispose();
      this.built.lists.dispose();
      for (const { object } of this.levels) if (object) disposeCopies(object);
    });
  }
}

/** What an InstancedLod is made of for its levels and lists: what its meshes draw with, its chunks and its loading. */
interface Built extends Drawing {
  readonly maxInstanceCount: number;
  readonly chunks: ChunkSet;
  readonly meshes: MeshesByLevel;
  readonly loads: LodLevelLoadManager;
  /** The levels as levelsToDraw reads them. */
  readonly encoded: EncodedLevels;
}

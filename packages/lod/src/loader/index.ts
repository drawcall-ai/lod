import { Box3, Group, Loader, LoadingManager, Vector3, type Material, type Object3D, type WebGPURenderer } from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MissingDependencyError, type CacheEntry } from "vitecache";
import { at } from "../at.js";
import { createBakeRenderer } from "../bake.js";
import { disposeRejected, disposeTree } from "../dispose.js";
import { framePixels } from "../impostor/impostor.js";
import { resolveThresholds, type LodLevel } from "../levels/index.js";
import { meshoptDecoder } from "../meshopt.js";
import { isMesh, isObject3D, rejectSkinned } from "../three.js";
import { buildLevel } from "./build.js";
import type { LodCacheOptions } from "./cache.js";
import { LodLoadContext, type Loaded } from "./context.js";
import { AssetDependencies, bundledModules } from "./dependencies.js";
import { decodeLevel, encodeLevel, encodeShape, placedBox, readLevel, readShape, shapeOf, type Entry, type Shape } from "./level.js";
import { auxiliary, cached, derived, levelEntry, normalize, shapeEntry, warmup, type Ladder, type LodRequest } from "./request.js";
import { assetPath, isLocal } from "./url.js";

// The loader: it describes a ladder of levels from a source, builds each level when first loaded and caches it.

/**
 * Loads asset URLs through manager handlers, else with a GLTFLoader of its own, which decodes meshopt only: register
 * a GLTFLoader configured with Draco or KTX2 decoders for models compressed with them, and a GLTSLoader for .glts
 * sources.
 *
 * Impostor and interior bakes draw with a renderer of the loader's own, made at its first bake: `dispose` frees it.
 */
export class LodLoader extends Loader<LodLevel[], LodRequest> {
  private gltf: GLTFLoader | undefined;
  /**
   * The renderer this loader bakes with, made at its first bake. Its own, not the app's: a canvas the size of a bake
   * frame would draw that frame over the whole target (see `bakeImpostor`).
   */
  private renderer: Promise<WebGPURenderer> | undefined;
  /** URLs whose builds this loader serves without saving, once it has warned why. */
  private readonly uncached = new Set<string>();

  constructor(
    manager?: LoadingManager,
    private readonly cacheOptions?: LodCacheOptions,
  ) {
    super(manager);
  }

  override load(
    request: LodRequest,
    onLoad: (levels: LodLevel[]) => void,
    _onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ): void {
    this.loadAsync(request).then(onLoad, onError ?? ((error: unknown) => console.error(error)));
  }

  /**
   * Describes the ladder from the cache, else from its source, which the first level loaded then takes. Empty levels
   * load with it, as does the source when it is the only drawable; other levels load when a camera needs them,
   * including a coarse stand-in while its first detail arrives, and each derived level is cached on its own and built
   * when first loaded. A level whose default threshold is measured from it is built with the ladder, as is every level
   * in a `vite build` warmup.
   *
   * What the levels load is freed when the last Lod holding them is disposed (see `LodLevel.hold`), which spends them:
   * a Lod made from them later throws, so call loadAsync again. Levels no Lod ever holds are never freed: they are
   * yours until a Lod holds them.
   */
  override async loadAsync(request: LodRequest): Promise<LodLevel[]> {
    const input = normalize(request, this.path);
    const { url, levels: requests } = input;
    // Only the inputs: what each build or the shape is saved with is captured by its own loads.
    const dependencies = new AssetDependencies(input.urls, this.manager);
    const context = new LodLoadContext(() => this.loadSource(url), input.onLevel);
    this.manager.itemStart(url);
    try {
      // vitecache resolves only same-origin paths to project files, so other sources build uncached.
      const modules = dependencies.requested.every(isLocal) ? await bundledModules(input.urls, this.manager) : undefined;
      const ladder: Ladder = { ...input, modules };
      // A simplified or baked level's default threshold is measured from its deviation, so it is built with the ladder.
      const eager = requests.flatMap((level, index) =>
        level.type !== "empty" && (warmup || (level.type !== "impostor" && level.maxPixels === undefined)) ? [index + 1] : [],
      );
      const reads = await Promise.all(eager.map(async (index) => ({ index, ...(await cached(levelEntry(ladder, index, dependencies, this.cacheOptions))) })));
      // Only what measures a default threshold: bytes no camera asked for are not held.
      const measured = new Map<number, Entry["level"]>();
      for (const { index, entry, bytes } of reads) {
        const level = bytes ?? (await this.persist(ladder, index, await context.source(), entry));
        if (!bytes) context.setBuilt(index, level);
        measured.set(index, readLevel(level).level);
      }
      const shape = await this.shape(ladder, dependencies, () => context.source());
      const box = placedBox(shape);
      if (box.isEmpty()) throw new Error("LodLoader: the source has no visible geometry to measure");
      const thresholds = resolveThresholds(
        [
          {},
          ...requests.map((level, position) => ({
            // An impostor's default is its frame's even when a warmup bakes it, as it is without one.
            maxPixels: level.maxPixels ?? (level.type === "impostor" ? framePixels(level.resolution) : undefined),
            measured: level.type === "impostor" ? undefined : measured.get(position + 1),
          })),
        ],
        shape.box.getSize(new Vector3()).length(),
        "LodLoader",
      );
      const { hold } = context;
      // Every load runs once however often it is asked for: every Lod made from the levels and the levels reading the
      // source's materials share one object. The source's starts synchronously, so it takes the spare before a coarser
      // level demanded in the same tick.
      const loadSource = once(async () => context.arrive((context.take() ?? (await this.loadSource(url))).source, 0, { materials: true }));
      const materials = async (): Promise<Material[]> => {
        const { object } = at(levels, 0);
        return materialsOf(object ?? (await loadSource()));
      };
      const deferred: DeferredLevel[] = [
        { load: loadSource, maxPixels: Infinity, box, hold },
        ...requests.map((level, position): DeferredLevel => {
          const index = position + 1;
          const maxPixels = at(thresholds, index);
          if (level.type === "empty")
            return { load: once(async () => context.arrive(new Group(), index, { materials: true })), maxPixels, box: new Box3(), hold };
          const load = once(async () => {
            const bytes = context.takeBuilt(index) ?? (await this.levelBytes(ladder, index, context.take()));
            const object = await decodeLevel(level.type, readLevel(bytes), materials, level.type === "impostor" ? level.draw : undefined);
            // A simplified level draws with the source level's materials, which that level frees.
            return context.arrive(object, index, { materials: level.type !== "simplify" });
          });
          return { load, maxPixels, box: box.clone(), hold };
        }),
      ];
      const levels = await preload(deferred);
      return levels;
    } catch (error) {
      context.fail();
      this.manager.itemError(url);
      throw error;
    } finally {
      this.manager.itemEnd(url);
    }
  }

  /** The source's shape from its entry, else measured from the source and saved. */
  private async shape(ladder: Ladder, dependencies: AssetDependencies, loadSource: () => Promise<Loaded>): Promise<Shape> {
    const { entry, bytes } = await cached(shapeEntry(ladder, dependencies, this.cacheOptions));
    if (bytes) return readShape(bytes);
    const { source, dependencies: read } = await loadSource();
    const shape = shapeOf(source);
    await this.save(ladder.url, entry, encodeShape(shape), read);
    return shape;
  }

  /**
   * A deferred level's bytes from its entry, else built from `spare`, the ladder's source, or from a source of its own:
   * the source level's carries onLevel effects. Disposes `spare` either way.
   */
  private async levelBytes(ladder: Ladder, index: number, spare: Loaded | undefined): Promise<Uint8Array> {
    const { entry, bytes } = await cached(levelEntry(ladder, index, new AssetDependencies(ladder.urls, this.manager), this.cacheOptions));
    if (bytes) {
      if (spare) disposeTree(spare.source);
      return bytes;
    }
    const loaded = spare ?? (await this.loadSource(ladder.url));
    try {
      return await this.persist(ladder, index, loaded, entry);
    } finally {
      disposeTree(loaded.source);
    }
  }

  /**
   * Build level `index` from `loaded`, and save it to `entry`, read before, when what it was built from can be validated
   * later: what loading the source read, and what this build loads besides.
   */
  private async persist(ladder: Ladder, index: number, { source, dependencies: read }: Loaded, entry: CacheEntry | undefined): Promise<Uint8Array> {
    const { urls } = ladder;
    const request = derived(ladder.levels, index);
    const dependencies = new AssetDependencies(urls, this.manager).include(read);
    const load = (name: "low" | "interior") => {
      const asset = urls[auxiliary(index, name)];
      return asset === undefined ? undefined : this.loadAsset(asset, dependencies);
    };
    let low: Object3D | undefined, interior: Object3D | undefined, built: Object3D | undefined;
    try {
      rejectSkinned(source, "LodLoader");
      low = await load("low");
      interior = await load("interior");
      built = await buildLevel(source, request, { low, interior }, () => this.bakeRenderer());
      const bytes = await encodeLevel(built, request.type, shapeOf(source), materialsOf(source));
      await this.save(ladder.url, entry, bytes, dependencies);
      return bytes;
    } finally {
      for (const object of [interior, low]) if (object) disposeTree(object);
      // A simplified level draws with the source's materials, which are freed with the source.
      if (built) disposeTree(built, { materials: request.type !== "simplify" });
    }
  }

  /** The renderer this loader bakes with, made at its first bake. */
  private bakeRenderer(): Promise<WebGPURenderer> {
    this.renderer ??= createBakeRenderer();
    return this.renderer;
  }

  /**
   * Free the renderer this loader made for its bakes; a bake under way fails. Levels it loaded stay as they are, and a
   * later bake makes a new renderer.
   */
  dispose(): void {
    const renderer = this.renderer;
    this.renderer = undefined;
    // A renderer that failed to initialise failed the bake that made it.
    void renderer?.then(
      (made) => made.dispose(),
      () => {},
    );
  }

  /** Save `bytes` to `entry`, read before, when what they were built from can be validated later; warn once otherwise. */
  private async save(url: string, entry: CacheEntry | undefined, bytes: Uint8Array, dependencies: AssetDependencies): Promise<void> {
    if (!entry) return this.warnUncached(url, "it is not a same-origin path");
    // Read now: GLTS sources go on reporting what they observe while levels are built.
    const saved = dependencies.saved();
    if ("reason" in saved) return this.warnUncached(url, saved.reason);
    if (this.uncached.has(url)) return;
    try {
      await entry.save(bytes, { dependencies: saved.dependencies });
    } catch (error) {
      // A dependency without a backing file, such as a middleware URL or a package the app does not install, cannot be validated.
      if (!(error instanceof MissingDependencyError)) throw error;
      this.warnUncached(url, error.message);
    }
  }

  /** Builds of `url` are served without saving from now on, after one warning naming why; a build warmup fails instead. */
  private warnUncached(url: string, reason: string): void {
    if (warmup) throw new Error(`LodLoader: cannot precompute "${url}": ${reason}`);
    if (this.uncached.has(url)) return;
    this.uncached.add(url);
    console.warn(`LodLoader: "${url}" is not cached by this loader: ${reason}`);
  }

  /** The ladder's source, with what loading it read. */
  private async loadSource(url: string): Promise<Loaded> {
    const dependencies = new AssetDependencies({ source: url }, this.manager);
    return { source: await this.loadAsset(url, dependencies), dependencies };
  }

  private async loadAsset(url: string, dependencies: AssetDependencies): Promise<Object3D> {
    const { path, extension } = assetPath(url);
    const handler = this.manager.getHandler(path);
    if (!handler && extension === "glts") throw new Error(`LodLoader: cannot load "${url}": register a GLTSLoader for .glts on the loading manager`);
    let result: unknown;
    if (handler) result = await handler.loadAsync(url);
    else {
      this.gltf ??= new GLTFLoader(this.manager).setMeshoptDecoder(meshoptDecoder());
      const decoder = this.gltf.setCrossOrigin(this.crossOrigin).setWithCredentials(this.withCredentials).setRequestHeader(this.requestHeader);
      result = await decoder.loadAsync(url);
    }
    const object = objectOf(result, url);
    try {
      dependencies.capture(url, object, result);
      return object;
    } catch (error) {
      disposeRejected(object);
      throw error;
    }
  }
}

/** `load`, run once however often it is called: every call shares its promise. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let started: Promise<T> | undefined;
  return () => (started ??= load());
}

function materialsOf(object: Object3D): Material[] {
  const materials: Material[] = [];
  object.traverse((node) => {
    if (isMesh(node)) for (const material of [node.material].flat()) materials.push(material);
  });
  return materials;
}

/** A level that loads on demand, as every level of a ladder starts. */
type DeferredLevel = LodLevel & { load: () => Promise<Object3D>; box: Box3; maxPixels: number };

/** Loads what every camera draws before it picks a level: the empty levels, and the source if it is the only drawable. */
async function preload(levels: DeferredLevel[]): Promise<LodLevel[]> {
  const drawable = levels.filter((level) => !level.box.isEmpty());
  return Promise.all(
    levels.map(async (level) =>
      level.box.isEmpty() || drawable.length === 1 ? { object: await level.load(), maxPixels: level.maxPixels, hold: level.hold } : level,
    ),
  );
}

function objectOf(result: unknown, url: string): Object3D {
  if (isObject3D(result)) return result;
  const scene: unknown = typeof result === "object" && result !== null ? Reflect.get(result, "scene") : undefined;
  if (isObject3D(scene)) return scene;
  throw new Error(`LodLoader: the handler for "${url}" did not load an Object3D or a glTF`);
}

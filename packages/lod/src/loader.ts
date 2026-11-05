import { Box3, Group, Loader, LoadingManager, Vector3, type Material, type Object3D } from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { CacheEntry } from "vitecache";
import { at } from "./at.js";
import { bakeMesh } from "./baked/index.js";
import { loadOnce } from "./deferred.js";
import { disposeRejected, disposeTree } from "./dispose.js";
import { bakeImpostor } from "./impostor/bake/index.js";
import { framePixels } from "./impostor/impostor.js";
import { ImpostorMesh } from "./impostor/mesh/index.js";
import { resolveThresholds, type LodLevel } from "./levels.js";
import type { LodCacheOptions } from "./loader/cache.js";
import { auxiliary, cached, derived, levelEntry, normalize, save, shapeEntry, warmup, type Ladder, type LodRequest } from "./loader/ladder.js";
import { decodeLevel, encodeLevel, encodeShape, placedBox, readLevel, readShape, shapeOf, type Derived, type Entry, type Shape } from "./loader/level.js";
import { bundledModules, Provenance } from "./loader/provenance.js";
import { Session, type Loaded } from "./loader/session.js";
import { assetPath, isLocal } from "./loader/url.js";
import { simplify } from "./simplify.js";
import { meshoptDecoder } from "./meshopt.js";
import { isMesh, isObject3D, placeLike, rejectSkinned } from "./three.js";

/** Loads asset URLs through manager handlers, falling back to GLTFLoader. Register a GLTSLoader for .glts sources. */
export class LodLoader extends Loader<LodLevel[], LodRequest> {
  private gltf: GLTFLoader | undefined;

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
   * load with it, as does the source when it is the only drawable; other levels load when a view selects them, and
   * each derived level is cached on its own and built when first loaded. A level whose default threshold is measured
   * from it is built with the ladder, as is every level in a `vite build` warmup.
   */
  override async loadAsync(request: LodRequest): Promise<LodLevel[]> {
    const input = normalize(request, this.path);
    const { url, levels: requests } = input;
    // Only the inputs: what each build or the shape is saved with is captured by its own loads.
    const provenance = new Provenance(input.urls, this.manager);
    const session = new Session(() => this.loadSource(url), input.onLevel);
    this.manager.itemStart(url);
    try {
      // vitecache resolves only same-origin paths to project files, so other sources build uncached.
      const modules = provenance.requested.every(isLocal) ? await bundledModules(input.urls, this.manager) : undefined;
      const ladder: Ladder = { ...input, modules };
      // A simplified or baked level's default threshold is measured from its deviation, so it is built with the ladder.
      const eager = requests.flatMap((level, index) =>
        level.type !== "empty" && (warmup || (level.type !== "impostor" && level.maxPixels === undefined)) ? [index + 1] : [],
      );
      const reads = await Promise.all(eager.map(async (index) => ({ index, ...(await cached(levelEntry(ladder, index, provenance, this.cacheOptions))) })));
      // Only what measures a default threshold: bytes no view asked for are not kept.
      const measured = new Map<number, Entry["level"]>();
      for (const { index, entry, bytes } of reads) {
        const level = bytes ?? (await this.persist(ladder, index, await session.source(), entry));
        if (!bytes) session.built.set(index, level);
        measured.set(index, readLevel(level).level);
      }
      const shape = await this.shape(ladder, provenance, () => session.source());
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
      );
      const materials = async (): Promise<Material[]> => {
        const level = at(levels, 0);
        return materialsOf(level.object ?? (await loadOnce(level.load).promise));
      };
      const { dispose } = session;
      const deferred: DeferredLevel[] = [
        { load: async () => session.arrive((session.take() ?? (await this.loadSource(url))).source, 0), maxPixels: Infinity, box, dispose },
        ...requests.map((level, position): DeferredLevel => {
          const index = position + 1;
          const maxPixels = at(thresholds, index);
          if (level.type === "empty") return { load: () => session.arrive(new Group(), index), maxPixels, box: new Box3(), dispose };
          const load = async () => {
            const bytes = session.takeBuilt(index) ?? (await this.lazy(ladder, index, session.take()));
            return session.arrive(await decodeLevel(level.type, readLevel(bytes), materials, level.type === "impostor" ? level.draw : undefined), index);
          };
          return { load, maxPixels, box: box.clone(), dispose };
        }),
      ];
      const levels = await preload(deferred);
      session.described();
      return levels;
    } catch (error) {
      session.fail();
      this.manager.itemError(url);
      throw error;
    } finally {
      this.manager.itemEnd(url);
    }
  }

  /** The source's shape from its entry, else measured from the source and saved. */
  private async shape(ladder: Ladder, provenance: Provenance, loadSource: () => Promise<Loaded>): Promise<Shape> {
    const { entry, bytes } = await cached(shapeEntry(ladder, provenance, this.cacheOptions));
    if (bytes) return readShape(bytes);
    const { source, provenance: read } = await loadSource();
    const shape = shapeOf(source);
    await save(ladder.url, entry, encodeShape(shape), read);
    return shape;
  }

  /**
   * A deferred level's bytes from its entry, else built from `spare`, the ladder's source, or from a source of its own:
   * the source level's carries onLevel effects. Disposes `spare` either way.
   */
  private async lazy(ladder: Ladder, index: number, spare: Loaded | undefined): Promise<Uint8Array> {
    const { entry, bytes } = await cached(levelEntry(ladder, index, new Provenance(ladder.urls, this.manager), this.cacheOptions));
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
  private async persist(ladder: Ladder, index: number, { source, provenance: read }: Loaded, entry: CacheEntry | undefined): Promise<Uint8Array> {
    const { urls } = ladder;
    const request = derived(ladder.levels, index);
    const provenance = new Provenance(urls, this.manager).include(read);
    const load = (name: "low" | "interior") => {
      const asset = urls[auxiliary(index, name)];
      return asset === undefined ? undefined : this.loadAsset(asset, provenance);
    };
    let low: Object3D | undefined, interior: Object3D | undefined, built: Object3D | undefined;
    try {
      rejectSkinned(source, "LodLoader");
      low = await load("low");
      interior = await load("interior");
      built = await this.build(source, request, low, interior);
      const bytes = await encodeLevel(built, request.type, shapeOf(source), materialsOf(source));
      await save(ladder.url, entry, bytes, provenance);
      return bytes;
    } finally {
      for (const object of [interior, built, low]) if (object) disposeTree(object);
    }
  }

  private async build(source: Object3D, request: Derived, low: Object3D | undefined, interior: Object3D | undefined): Promise<Object3D> {
    switch (request.type) {
      case "simplify":
        return simplify(source, { ratio: request.ratio });
      case "impostor": {
        const { type: _, draw: __, ...options } = request;
        const object = new ImpostorMesh(await bakeImpostor(source, options));
        object.name = `${source.name || "object"} impostor`;
        placeLike(object, source);
        return object;
      }
      case "baked":
        return bakeMesh(
          source,
          low ? { low, interior, textureSize: request.textureSize } : { ratio: request.ratio, interior, textureSize: request.textureSize },
        );
    }
  }

  /** The ladder's source, with what loading it read. */
  private async loadSource(url: string): Promise<Loaded> {
    const provenance = new Provenance({ source: url }, this.manager);
    return { source: await this.loadAsset(url, provenance), provenance };
  }

  private async loadAsset(url: string, provenance: Provenance): Promise<Object3D> {
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
      provenance.capture(url, object, result);
      return object;
    } catch (error) {
      disposeRejected(object);
      throw error;
    }
  }
}

function materialsOf(object: Object3D): Material[] {
  const materials: Material[] = [];
  object.traverse((node) => {
    if (isMesh(node)) for (const material of [node.material].flat()) materials.push(material);
  });
  return materials;
}

/** A level that loads on demand, as every level of a ladder starts. */
type DeferredLevel = Extract<LodLevel, { load: unknown }>;

/** Loads what every view draws before any selects a level: the empty levels, and the source if it is the only drawable. */
async function preload(levels: DeferredLevel[]): Promise<LodLevel[]> {
  const drawable = levels.filter((level) => !level.box.isEmpty());
  return Promise.all(
    levels.map(async (level) =>
      level.box.isEmpty() || drawable.length === 1 ? { object: await loadOnce(level.load).promise, maxPixels: level.maxPixels } : level,
    ),
  );
}

function objectOf(result: unknown, url: string): Object3D {
  if (isObject3D(result)) return result;
  const scene: unknown = typeof result === "object" && result !== null ? Reflect.get(result, "scene") : undefined;
  if (isObject3D(scene)) return scene;
  throw new Error(`LodLoader: the handler for "${url}" did not load an Object3D or a glTF`);
}

import { Box3, Group, Loader, LoadingManager, Vector3, type Material, type Object3D } from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MissingDependencyError, type CacheEntry } from "vitecache";
import { at } from "./at.js";
import { bakeMesh } from "./baked/index.js";
import { loadOnce } from "./deferred.js";
import { disposeRejected, disposeTree } from "./dispose.js";
import { bakeImpostor, type BakeImpostorOptions } from "./impostor/bake/index.js";
import { ImpostorMesh, type ImpostorMeshOptions } from "./impostor/mesh/index.js";
import { resolveThresholds, type LodLevel } from "./levels.js";
import { levelEntry, type LodCacheOptions } from "./loader/cache.js";
import { decodeLevel, encodeLevel, placedBox, readLevel, shapeOf, type Derived } from "./loader/level.js";
import { bundledModules, Provenance } from "./loader/provenance.js";
import { assetPath, isLocal, loaderPathURL, sourceRelativeURL } from "./loader/url.js";
import { simplify, type SimplifyOptions } from "./simplify.js";
import { meshoptDecoder } from "./meshopt.js";
import { isMesh, isObject3D, placeLike, rejectSkinned } from "./three.js";

/**
 * Levels derived from the source, finest first. Each derived level is built and persisted when it first loads; a level
 * without `maxPixels` is built with the ladder, since its default threshold is measured from it, and so is every level
 * in a `vite build` warmup. Changing `maxPixels`
 * or an impostor's `draw` reuses them, except an impostor's `maxPixels`, which also sizes its bake.
 */
export type LevelRequest =
  | ({ type: "simplify"; maxPixels?: number } & SimplifyOptions)
  | ({
      type: "baked";
      maxPixels?: number;
      textureSize?: number;
      /** Room geometry for window baking, as an asset URL relative to the source. */
      interior?: string;
    } & (
      | {
          /** Authored low shell to bake onto, as an asset URL relative to the source. */
          low: string;
          ratio?: never;
        }
      | { low?: never; ratio?: number }
    ))
  | ({ type: "impostor"; draw?: ImpostorMeshOptions } & BakeImpostorOptions)
  | { type: "empty"; maxPixels: number };

/** A .glb, .gltf or .glts asset URL. Source and simplified levels load the original asset on demand. */
export type LodRequest =
  | string
  | {
      url: string;
      levels?: readonly LevelRequest[];
      /**
       * Apply runtime effects when a level arrives, before draws compile. Does not change baked content or bounds.
       * `index` is the returned ladder's: 0 is the source, and `levels[i]` arrives as `i + 1`.
       */
      onLevel?: (object: Object3D, index: number) => void | Promise<void>;
    };
const DEFAULT_LEVELS: readonly LevelRequest[] = [{ type: "impostor" }];

/**
 * Whether this runs in the warmup of a `vite build`, which runs public .glts scripts in Node: what they load is
 * precomputed into the deployed cache, so every level is built and saved, and a level that cannot be saved fails the
 * build. Vite defines `import.meta.env` for the app's packages; glts's warmup gives Node imports the same.
 */
const warmup = import.meta.env?.PROD === true && import.meta.env?.SSR === true;
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
   * Load empty levels and the coarsest drawable eagerly; finer drawables load on demand. Each derived level is cached on
   * its own and built when first loaded, except a level whose default threshold is measured from it, which is built
   * eagerly, as is every level in a `vite build` warmup.
   */
  override async loadAsync(request: LodRequest): Promise<LodLevel[]> {
    const input = normalize(request, this.path);
    const { url, levels: requests } = input;
    const provenance = new Provenance(input.urls, this.manager);
    let source: Object3D | undefined;
    let preloading = true;
    const owned = new Set<Object3D>();
    const release = (object: Object3D) => {
      owned.delete(object);
      disposeRejected(object);
    };
    const loadSource = async () => {
      source ??= await this.loadAsset(url, provenance);
      if (preloading) owned.add(source);
      return source;
    };
    this.manager.itemStart(url);
    try {
      // vitecache resolves only same-origin paths to project files, so other sources build uncached.
      const modules = provenance.requested.every(isLocal) ? await bundledModules(input.urls, this.manager) : undefined;
      const ladder: Ladder = { ...input, modules };
      const coarsest = requests.reduce((last, level, index) => (level.type === "empty" ? last : index + 1), 0);
      const eager = requests.flatMap((level, index) =>
        level.type !== "empty" && (warmup || index + 1 === coarsest || level.maxPixels === undefined) ? [index + 1] : [],
      );
      // The eager builds share one source and provenance, so each saves what all of them revealed: a superset of its own.
      const entries = eager.map((index) => this.entry(ladder, index, provenance));
      const cached = await Promise.all(entries.map((entry) => entry?.load()));
      // Bytes of the eager levels, each handed over once: loadOnce decodes each level once per ladder, and a later call reads the cache.
      const handed = new Map<number, Uint8Array>();
      for (const [position, index] of eager.entries())
        handed.set(index, cached[position] ?? (await this.persist(ladder, index, await loadSource(), provenance, entries[position])));
      const read = new Map([...handed].map(([index, bytes]) => [index, readLevel(bytes)]));
      const shape = read.get(coarsest)?.shape ?? shapeOf(await loadSource());
      const box = placedBox(shape);
      if (box.isEmpty()) throw new Error("LodLoader: the source has no visible geometry to measure");
      const thresholds = resolveThresholds(
        [{}, ...requests.map((level, position) => ({ maxPixels: level.maxPixels, measured: read.get(position + 1)?.level }))],
        shape.box.getSize(new Vector3()).length(),
      );
      const arrive = async (object: Object3D, index: number) => {
        try {
          if (preloading) owned.add(object);
          await input.onLevel?.(object, index);
          return object;
        } catch (error) {
          release(object);
          throw error;
        }
      };
      const materials = async (): Promise<Material[]> => {
        const level = at(levels, 0);
        return materialsOf(level.object ?? (await loadOnce(level.load).promise));
      };
      const levels: LodLevel[] = [
        { load: async () => arrive(await loadSource(), 0), maxPixels: Infinity, box },
        ...requests.map((level, position): LodLevel => {
          const index = position + 1;
          const maxPixels = at(thresholds, index);
          if (level.type === "empty") return { load: () => arrive(new Group(), index), maxPixels, box: new Box3() };
          const load = async () => {
            const bytes = handed.get(index) ?? (await this.lazy(ladder, index));
            handed.delete(index);
            return arrive(await decodeLevel(level.type, readLevel(bytes), materials, level.type === "impostor" ? level.draw : undefined), index);
          };
          return { load, maxPixels, box: box.clone() };
        }),
      ];
      await preload(levels, source !== undefined);
      preloading = false;
      owned.clear();
      return levels;
    } catch (error) {
      for (const object of owned) release(object);
      this.manager.itemError(url);
      throw error;
    } finally {
      this.manager.itemEnd(url);
    }
  }

  /** The cache entry of level `index`, keyed by the inputs it is built from; undefined when the ladder is not cacheable. */
  private entry({ levels, modules }: Ladder, index: number, provenance: Provenance): CacheEntry | undefined {
    if (!modules) return undefined;
    // Keyed by role rather than ladder position, so adding or removing another level keeps this one's entry.
    const roles = { source: "source", low: auxiliary(index, "low"), interior: auxiliary(index, "interior") };
    const pick = <T>(values: Readonly<Record<string, T>>): Record<string, T> =>
      Object.fromEntries(
        Object.entries(roles).flatMap(([role, name]) => {
          const value = values[name];
          return value === undefined ? [] : [[role, value] as const];
        }),
      );
    return levelEntry(pick(provenance.inputs), derived(levels, index), pick(modules), this.cacheOptions);
  }

  /** A deferred level's bytes from its entry, else built from a source of its own: the ladder's source carries onLevel effects. */
  private async lazy(ladder: Ladder, index: number): Promise<Uint8Array> {
    const provenance = new Provenance(ladder.urls, this.manager);
    const entry = this.entry(ladder, index, provenance);
    const cached = await entry?.load();
    if (cached) return cached;
    const source = await this.loadAsset(ladder.url, provenance);
    try {
      return await this.persist(ladder, index, source, provenance, entry);
    } finally {
      disposeTree(source);
    }
  }

  /** Build level `index` from `source`, and save it to `entry` when what it was built from can be validated later. */
  private async persist(ladder: Ladder, index: number, source: Object3D, provenance: Provenance, entry: CacheEntry | undefined): Promise<Uint8Array> {
    const { url, urls } = ladder;
    const request = derived(ladder.levels, index);
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
      if (!entry) {
        warnUncached(url, "it is not a same-origin path");
        return bytes;
      }
      // Read now: GLTS sources keep reporting what they observe while levels are built.
      const saved = provenance.dependencies();
      if ("reason" in saved) {
        warnUncached(url, saved.reason);
        return bytes;
      }
      if (uncached.has(url)) return bytes;
      try {
        await entry.save(bytes, { dependencies: saved.dependencies });
      } catch (error) {
        // A dependency without a backing file, such as a middleware URL or a package the app does not install, cannot be validated.
        if (!(error instanceof MissingDependencyError)) throw error;
        warnUncached(url, error.message);
      }
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
    const object = sceneOf(result, url);
    try {
      provenance.capture(url, object, result);
      return object;
    } catch (error) {
      disposeRejected(object);
      throw error;
    }
  }
}

/** A normalized request, with the digests of its bundled modules when its levels are cacheable. */
type Ladder = ReturnType<typeof normalize> & { modules: Record<string, string> | undefined };

/** The request of ladder level `index`, which must be a derived level. */
function derived(levels: readonly LevelRequest[], index: number): Derived {
  const level = levels[index - 1];
  if (!level || level.type === "empty") throw new Error(`LodLoader: level ${index} is not derived`);
  return level;
}

function materialsOf(object: Object3D): Material[] {
  const materials: Material[] = [];
  object.traverse((node) => {
    if (isMesh(node)) for (const material of [node.material].flat()) materials.push(material);
  });
  return materials;
}

function normalize(request: LodRequest, path: string) {
  const input = typeof request === "string" ? { url: request } : request;
  const url = loaderPathURL(input.url, path);
  const levels = structuredClone(input.levels ?? DEFAULT_LEVELS);
  const urls: Record<string, string> = { source: url };
  levels.forEach((level, position) => {
    if (level.type !== "baked") return;
    for (const name of ["low", "interior"] as const) {
      const value = level[name];
      if (value !== undefined) urls[auxiliary(position + 1, name)] = sourceRelativeURL(value, url);
    }
  });
  return { ...input, url, levels, urls };
}

const uncached = new Set<string>();

/** Builds of `url` are served without saving from now on, after one warning naming why; a build warmup fails instead. */
function warnUncached(url: string, reason: string): void {
  if (warmup) throw new Error(`LodLoader: cannot precompute "${url}": ${reason}`);
  if (uncached.has(url)) return;
  uncached.add(url);
  console.warn(`LodLoader: "${url}" is not cached until the page reloads: ${reason}`);
}

/** Provenance name of the low or interior asset of the baked level at ladder index `level`. */
const auxiliary = (level: number, name: "low" | "interior") => `auxiliary:${level}:${name}`;

async function preload(levels: LodLevel[], hasSource: boolean): Promise<void> {
  // A cold build hands its source to the same shared lifetime as a deferred source arrival.
  if (hasSource && levels[0]?.load) await loadOnce(levels[0].load).promise;
  const coarse = [...levels].reverse().find((level) => level.box && !level.box.isEmpty());
  if (!coarse?.load) throw new Error("LodLoader: ladder has no drawable level");
  for (const [index, level] of levels.entries()) {
    if (level.load && (level === coarse || level.box.isEmpty())) levels[index] = { object: await loadOnce(level.load).promise, maxPixels: level.maxPixels };
  }
}

function sceneOf(result: unknown, url: string): Object3D {
  if (isObject3D(result)) return result;
  const scene: unknown = typeof result === "object" && result !== null ? Reflect.get(result, "scene") : undefined;
  if (isObject3D(scene)) return scene;
  throw new Error(`LodLoader: the handler for "${url}" did not load an Object3D or a glTF`);
}

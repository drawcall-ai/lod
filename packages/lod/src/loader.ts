import { Group, Loader, LoadingManager, type Object3D } from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { MissingDependencyError, type CacheEntry } from "vitecache";
import { bakeMesh } from "./baked/index.js";
import { loadOnce } from "./deferred.js";
import { disposeRejected, disposeTree } from "./dispose.js";
import { bakeImpostor, type BakeImpostorOptions } from "./impostor/bake/index.js";
import { ImpostorMesh, type ImpostorMeshOptions } from "./impostor/mesh/index.js";
import type { LodLevel } from "./levels.js";
import { decode, encode, separateLevels, type Kind } from "./loader/bundle.js";
import { indexEntry, payloadEntry, sha256, type LodCacheOptions } from "./loader/cache.js";
import { bundledModules, Provenance } from "./loader/provenance.js";
import { assetPath, isLocal, loaderPathURL, sourceRelativeURL } from "./loader/url.js";
import { simplify, type SimplifyOptions } from "./simplify.js";
import { isObject3D, placeLike, rejectSkinned } from "./three.js";

/**
 * Levels derived from the source, finest first. Computed geometry and baked results are persisted.
 * Changing `maxPixels` or an impostor's `draw` reuses them, except an impostor's `maxPixels`, which also sizes its bake.
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
let meshoptWorkers = false;
/** A level request with the meshes its URLs name, loaded before building. */
interface LevelJob {
  request: LevelRequest;
  low?: Object3D;
  interior?: Object3D;
}

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

  /** Load empty levels and the coarsest drawable eagerly; finer drawables load on demand. */
  override async loadAsync(request: LodRequest): Promise<LodLevel[]> {
    const input = normalize(request, this.path);
    const { url, levels } = input;
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
      const entry = provenance.requested.every(isLocal)
        ? indexEntry(provenance.inputs, levels, await bundledModules(input.urls, this.manager), this.cacheOptions)
        : undefined;
      const cached = await entry?.load();
      // A cold build hands over the payloads it encoded instead of reading back saves that may have been skipped.
      // Each is handed over once, since loadOnce decodes each level once per ladder; a later call reads the cache.
      let payloads: Map<number, Uint8Array> | undefined;
      let index: Uint8Array;
      if (cached === undefined) {
        ({ index, levels: payloads } = await this.persist(await loadSource(), input, provenance, entry));
      } else index = cached;
      let hash: Promise<string> | undefined;
      const result = decode(
        index,
        [{}, ...levels],
        loadSource,
        async (level) => {
          const handed = payloads?.get(level);
          payloads?.delete(level);
          if (handed) return handed;
          const payload = await payloadEntry(await (hash ??= sha256(index)), level, this.cacheOptions).load();
          if (payload === undefined) throw new Error(`LodLoader: cached level ${level} is missing`);
          return payload;
        },
        async (object, level) => {
          if (preloading) owned.add(object);
          await input.onLevel?.(object, level);
        },
        release,
      );
      await preload(result, source !== undefined);
      preloading = false;
      owned.clear();
      return result;
    } catch (error) {
      for (const object of owned) release(object);
      this.manager.itemError(url);
      throw error;
    } finally {
      this.manager.itemEnd(url);
    }
  }

  private async persist(
    source: Object3D,
    { url, levels: requests, urls }: { url: string; levels: readonly LevelRequest[]; urls: Readonly<Record<string, string>> },
    provenance: Provenance,
    entry: CacheEntry | undefined,
  ): Promise<Awaited<ReturnType<typeof encode>>> {
    const built = [source];
    const jobs: LevelJob[] = requests.map((request) => ({ request }));
    try {
      rejectSkinned(source, "LodLoader");
      const load = (key: string) => {
        const asset = urls[key];
        return asset === undefined ? undefined : this.loadAsset(asset, provenance);
      };
      for (const [position, job] of jobs.entries()) {
        job.low = await load(auxiliary(position, "low"));
        job.interior = await load(auxiliary(position, "interior"));
      }
      const kinds: Kind[] = ["source", ...requests.map((request) => request.type)];
      for (const job of jobs) built.push(await this.build(source, job));
      const encoded = await encode(built, kinds);
      if (!entry) {
        warnUncached(url, "it is not a same-origin path");
        return encoded;
      }
      // Read now: GLTS sources keep reporting what they observe while levels are built.
      const saved = provenance.dependencies();
      if ("reason" in saved) {
        warnUncached(url, saved.reason);
        return encoded;
      }
      if (uncached.has(url)) return encoded;
      const { dependencies } = saved;
      // A warm load reads the index, then payloads on demand, so publish in reverse.
      const hash = await sha256(encoded.index);
      for (const level of separateLevels(kinds)) {
        const bytes = encoded.levels.get(level);
        if (!bytes) throw new Error(`LodLoader: level ${level} was not encoded`);
        await payloadEntry(hash, level, this.cacheOptions).save(bytes);
      }
      try {
        await entry.save(encoded.index, { dependencies });
      } catch (error) {
        // A dependency without a backing file, such as a middleware URL or a package the app does not install, cannot be validated.
        if (!(error instanceof MissingDependencyError)) throw error;
        warnUncached(url, error.message);
      }
      return encoded;
    } finally {
      for (const object of [...jobs.map((job) => job.interior), ...built.slice(1), ...jobs.map((job) => job.low)]) if (object) disposeTree(object);
    }
  }

  private async build(source: Object3D, { request, low, interior }: LevelJob): Promise<Object3D> {
    switch (request.type) {
      case "empty":
        return new Group();
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
      if (!meshoptWorkers && MeshoptDecoder.supported) {
        MeshoptDecoder.useWorkers(2);
        meshoptWorkers = true;
      }
      this.gltf ??= new GLTFLoader(this.manager).setMeshoptDecoder(MeshoptDecoder);
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

function normalize(request: LodRequest, path: string) {
  const input = typeof request === "string" ? { url: request } : request;
  const url = loaderPathURL(input.url, path);
  const levels = structuredClone(input.levels ?? DEFAULT_LEVELS);
  const urls: Record<string, string> = { source: url };
  levels.forEach((level, index) => {
    if (level.type !== "baked") return;
    for (const name of ["low", "interior"] as const) {
      const value = level[name];
      if (value !== undefined) urls[auxiliary(index, name)] = sourceRelativeURL(value, url);
    }
  });
  return { ...input, url, levels, urls };
}

const uncached = new Set<string>();

/** Builds of `url` are served without saving from now on, after one warning naming why. */
function warnUncached(url: string, reason: string): void {
  if (uncached.has(url)) return;
  uncached.add(url);
  console.warn(`LodLoader: "${url}" is not cached until the page reloads: ${reason}`);
}

/** Provenance name of a baked level's low or interior asset. */
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

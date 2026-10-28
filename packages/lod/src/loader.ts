import { Loader, LoaderUtils, type LoadingManager, type Object3D } from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { getGLTSSource, type GLTSSource } from "@drawcall/glts";
import { bakeMesh } from "./baked/index.js";
import { measureLevels } from "./bounds.js";
import { disposeTree } from "./dispose.js";
import type { BakeImpostorOptions } from "./impostor/bake/index.js";
import type { Impostor } from "./impostor/impostor.js";
import { ImpostorMesh } from "./impostor/mesh/index.js";
import { InstancedLod } from "./instanced/index.js";
import { estimate, Level, validate } from "./levels.js";
import { Lod } from "./lod.js";
import { LazyImpostor } from "./lazy.js";
import { impostor, originOf, type LodCacheOptions } from "./loader/cache.js";
import { disposeSimplified } from "./loader/dispose.js";
export type { LodCacheOptions } from "./loader/cache.js";
import { simplify, type SimplifyOptions } from "./simplify.js";
import { isLOD, isObject3D, placeLike, rejectSkinned } from "./three.js";

/** A level the loader builds from the source, cheapest last; `maxPixels` overrides its default (see `LodLevel.maxPixels`). */
export type LevelRequest =
  | ({ type: "simplified"; maxPixels?: number } & SimplifyOptions)
  | ({
      type: "baked";
      maxPixels?: number;
      textureSize?: number;
      /**
       * URL of the rooms to show through the model's glass (see `BakeMeshOptions.interior`),
       * loaded like the model and relative to it. It is added to the model after every
       * level is built, so up close the real rooms show through the real glass. Only one
       * baked level of a model may have one.
       */
      interior?: string;
    } & (
      | {
          /**
           * URL of the mesh to bake onto (.glts, .glb or .gltf), loaded like the model. A
           * relative URL is relative to the model's: a model and its low mesh live together.
           */
          low: string;
          ratio?: never;
        }
      | { low?: never; ratio?: number }
    ))
  | ({
      type: "impostor";
      /** Build only when needed; requires an explicit positive maxPixels. Default false. */
      lazy?: boolean;
    } & BakeImpostorOptions);

/**
 * A model URL (.glb, .gltf or .glts), or the complete asset passed from its active GLTS
 * script. The whole GLTS asset is the cache unit, not individual parts of its scene.
 * GLTS impostors persist through vitecache; its Vite plugin tracks the script and its
 * dependency files. Pass an object only after its dependency loads have finished;
 * deferred impostors read retained dependencies when loading begins.
 */
export type LodRequest = string | Object3D | { url: string; levels?: readonly LevelRequest[] } | { source: Object3D; levels?: readonly LevelRequest[] };

const DEFAULT_LEVELS: readonly LevelRequest[] = [{ type: "impostor" }];

/**
 * Loads a model and builds a `Lod` of it: the model as level 0, then the requested
 * levels (default: an impostor). Unless explicitly lazy, building runs at load time; impostors bake on a
 * renderer this package keeps for that. Each level's maxPixels is its default (see
 * `LodLevel.maxPixels`) unless the request sets it; a failed load frees what it built.
 *
 * Models load through the manager's handler for the URL if one is registered: a
 * GLTFLoader with Draco or meshopt decoders, or for .glts a GLTSLoader from
 * @drawcall/glts (inside a .glts script, the contextual `gltsLoader`, registered on the
 * contextual `loadingManager`). Without one, .glb/.gltf load with a plain GLTFLoader and
 * .glts fails. URLs resolve against `path` as GLTFLoader's do; a baked level's `low` and
 * `interior` URLs load the same way, relative to the model's URL.
 */
export class LodLoader extends Loader<Lod, LodRequest> {
  private gltf: GLTFLoader | undefined;

  constructor(
    manager?: LoadingManager,
    private readonly cacheOptions?: LodCacheOptions,
  ) {
    super(manager);
  }

  override load(request: LodRequest, onLoad: (lod: Lod) => void, _onProgress?: (event: ProgressEvent) => void, onError?: (error: unknown) => void): void {
    // As three's loaders: without onError, the failure goes to the console.
    this.loadAsync(request).then(onLoad, onError ?? ((error: unknown) => console.error(error)));
  }

  override async loadAsync(request: LodRequest): Promise<Lod> {
    return this.loading(request, (object, levels, base, origin) => this.build(object, levels, base, (objects) => new Lod(objects), origin));
  }

  /** Load `request` as `count` instances: an `InstancedLod`. */
  async loadInstancesAsync(request: LodRequest, count: number): Promise<InstancedLod> {
    return this.loading(request, (object, levels, base, origin) => this.build(object, levels, base, (objects) => new InstancedLod(objects, count), origin));
  }

  /** Build a `Lod` of the complete `object` inside GLTS. Relative low/interior URLs use the script's directory. */
  async parseAsync(object: Object3D, levels: readonly LevelRequest[] = DEFAULT_LEVELS): Promise<Lod> {
    return this.loadAsync({ source: object, levels });
  }

  /** Build an `InstancedLod` of the complete `object` inside GLTS. */
  async parseInstancesAsync(object: Object3D, count: number, levels: readonly LevelRequest[] = DEFAULT_LEVELS): Promise<InstancedLod> {
    return this.loadInstancesAsync({ source: object, levels }, count);
  }

  /**
   * `make` of `object` and its requested levels, with the maxPixels requested; `low` and
   * `interior` URLs resolve against `base`. On failure, the levels built and interiors
   * loaded are freed and `object` is left out of any Lod.
   */
  private async build<T extends Lod | InstancedLod>(
    object: Object3D,
    requests: readonly LevelRequest[],
    base: string,
    make: (objects: Object3D[]) => T,
    origin?: GLTSSource,
  ): Promise<T> {
    rejectSkinned(object, "LodLoader");
    if (requests.filter((request) => request.type === "baked" && request.interior !== undefined).length > 1)
      throw new Error("LodLoader: give an interior to one baked level only: the source shows one");
    const built: Object3D[] = [];
    const interiors: Object3D[] = [];
    try {
      // One at a time: bakes share one renderer.
      for (const request of requests) {
        const { level, interior } = await this.buildLevel(object, request, base, origin, interiors);
        built.push(level);
        if (interior) interiors.push(interior);
      }
      // Eager bakes have finished; deferred bakes exclude these attached children.
      if (interiors.length > 0) object.add(...interiors);
      const objects = [object, ...built];
      // Reject bad overrides before a constructor hooks the caller's source or
      // allocates a crowd's pooled indirect arguments and selection buffers.
      const preview: Level[] = [];
      objects.forEach((object, i) => preview.push(new Level(object, i, isLOD(object), preview)));
      estimate(preview, 2 * measureLevels(objects, "LodLoader").own.radius);
      requests.forEach(({ maxPixels }, i) => {
        const level = preview[i + 1];
        if (level && maxPixels !== undefined) level.maxPixels = maxPixels;
      });
      validate(preview);
      const lod = make(objects);
      for (const [i, { maxPixels }] of requests.entries()) {
        const level = lod.levels[i + 1];
        if (!level) throw new Error("LodLoader: a built level is missing");
        if (maxPixels !== undefined) level.maxPixels = maxPixels;
      }
      return lod;
    } catch (error) {
      built.forEach((level, i) => {
        if (requests[i]?.type === "simplified") disposeSimplified(level, object);
        else disposeTree(level);
      });
      for (const interior of interiors) {
        object.remove(interior);
        disposeTree(interior);
      }
      throw error;
    }
  }

  /** The level `request` asks for, and the interior a baked level loaded for the source. */
  private async buildLevel(
    source: Object3D,
    request: LevelRequest,
    base: string,
    origin?: GLTSSource,
    interiors: readonly Object3D[] = [],
  ): Promise<{ level: Object3D; interior?: Object3D }> {
    switch (request.type) {
      case "simplified": {
        const { type: _, maxPixels: __, ...options } = request;
        return { level: await simplify(source, options) };
      }
      case "baked":
        return this.bake(source, request, base);
      case "impostor": {
        const { type: _, lazy, ...options } = request;
        if (lazy) {
          const { maxPixels } = options;
          if (maxPixels === undefined || !Number.isFinite(maxPixels) || maxPixels <= 0)
            throw new Error("LodLoader: a lazy impostor needs an explicit positive maxPixels");
          const level = new LazyImpostor(() => impostor(source, options, origin, interiors, this.cacheOptions), { maxPixels });
          level.name = `${source.name || "object"} impostor`;
          placeLike(level, source);
          return { level };
        }
        return { level: impostorOf(source, await impostor(source, options, origin, [], this.cacheOptions)) };
      }
      default: {
        const unknown: never = request;
        throw new Error(`LodLoader: unknown level type in ${JSON.stringify(unknown)}`);
      }
    }
  }

  /**
   * Bake `source` as `request` asks, loading its low mesh and interior relative to `base`.
   * The low mesh is freed after: only the bake keeps it. The interior is returned for the
   * source, or freed if the bake fails.
   */
  private async bake(source: Object3D, request: Extract<LevelRequest, { type: "baked" }>, base: string): Promise<{ level: Object3D; interior?: Object3D }> {
    const { textureSize } = request;
    const load = (url: string | undefined) => (url === undefined ? undefined : this.loadSource(LoaderUtils.resolveURL(url, base)));
    const low = await load(request.low);
    let interior: Object3D | undefined;
    try {
      interior = await load(request.interior);
      const level = await bakeMesh(source, low ? { low, textureSize, interior } : { ratio: request.ratio, textureSize, interior });
      return { level, interior };
    } catch (error) {
      if (interior) disposeTree(interior);
      throw error;
    } finally {
      if (low) disposeTree(low);
    }
  }

  /**
   * Load `request`'s model and `build` it, reporting to the manager as one item; `build`
   * gets the model's directory. On failure, the model is freed.
   */
  private async loading<T>(
    request: LodRequest,
    build: (object: Object3D, levels: readonly LevelRequest[], base: string, origin?: GLTSSource) => Promise<T>,
  ): Promise<T> {
    const input = typeof request === "string" ? { url: request } : isObject3D(request) ? { source: request } : request;
    const { levels = DEFAULT_LEVELS } = input;
    if ("source" in input) {
      // Native async code loses the GLTS execution after its first await.
      const source = getGLTSSource();
      return build(input.source, levels, LoaderUtils.extractUrlBase(source.url), source);
    }
    const { url } = input;
    const full = LoaderUtils.resolveURL(url, this.path);
    this.manager.itemStart(full);
    let object: Object3D | undefined;
    try {
      object = await this.loadSource(full);
      const origin = originOf(object);
      return await build(object, levels, LoaderUtils.extractUrlBase(origin?.url ?? full), origin);
    } catch (error) {
      if (object) disposeTree(object);
      this.manager.itemError(full);
      throw error;
    } finally {
      this.manager.itemEnd(full);
    }
  }

  private async loadSource(url: string): Promise<Object3D> {
    const extension = /\.(glb|gltf|glts)$/i.exec(url.split(/[?#]/)[0] ?? "")?.[1]?.toLowerCase();
    if (!extension) throw new Error(`LodLoader: cannot load "${url}": expected a .glb, .gltf or .glts file`);
    const handler = this.manager.getHandler(url);
    if (handler) return sceneOf(await handler.loadAsync(url), url);
    // No GLTSLoader of our own: inside a .glts script only the contextual one may load,
    // so the app registers the one to use.
    if (extension === "glts") throw new Error(`LodLoader: cannot load "${url}": register a GLTSLoader for .glts on the loading manager`);
    this.gltf ??= new GLTFLoader(this.manager);
    return (await this.configure(this.gltf).loadAsync(url)).scene;
  }

  /** `loader` with this loader's request settings. */
  private configure(loader: GLTFLoader): GLTFLoader {
    loader.setCrossOrigin(this.crossOrigin).setWithCredentials(this.withCredentials).setRequestHeader(this.requestHeader);
    return loader;
  }
}

/** An ImpostorMesh placed and shadowed like `source`. */
function impostorOf(source: Object3D, impostor: Impostor): ImpostorMesh {
  const mesh = new ImpostorMesh(impostor);
  mesh.name = `${source.name || "object"} impostor`;
  placeLike(mesh, source);
  return mesh;
}

/** The object a handler loaded: an Object3D, or a glTF result's scene. */
function sceneOf(result: unknown, url: string): Object3D {
  if (isObject3D(result)) return result;
  const scene: unknown = typeof result === "object" && result !== null ? Reflect.get(result, "scene") : undefined;
  if (isObject3D(scene)) return scene;
  throw new Error(`LodLoader: the handler for "${url}" did not load an Object3D or a glTF`);
}

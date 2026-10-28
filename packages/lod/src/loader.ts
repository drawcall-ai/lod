import { Group, Loader, LoaderUtils, LoadingManager, type Object3D } from "three/webgpu";
import type { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Dependencies } from "vitecache";
import { bakeMesh } from "./baked/index.js";
import { boundingBox, measureLevels } from "./bounds.js";
import { disposeTree } from "./dispose.js";
import { bakeImpostor, type BakeImpostorOptions } from "./impostor/bake/index.js";
import { ImpostorMesh, type ImpostorMeshOptions } from "./impostor/mesh/index.js";
import { LazyLevel } from "./lazy.js";
import { estimate, Level, validate, type LodLevel } from "./levels.js";
import { Lod } from "./lod.js";
import { decode, encode, type Kind } from "./loader/bundle.js";
import { entryFor, type LodCacheOptions, type Recipe } from "./loader/cache.js";
import { gltfLoader, type MaterialResolver } from "./loader/mesh.js";
import { Provenance } from "./loader/provenance.js";
import { simplify, type SimplifyOptions } from "./simplify.js";
import { isLOD, isObject3D, placeLike, rejectSkinned } from "./three.js";
export type { LodCacheOptions } from "./loader/cache.js";

type Factory = () => Promise<Object3D>;
type Auxiliary = string | Factory;

type DerivedLevel =
  | ({ type: "mesh"; maxPixels?: number } & SimplifyOptions)
  | ({
      type: "baked";
      maxPixels?: number;
      textureSize?: number;
      /** Rooms added to the source after all exterior levels are built. */
      interior?: Auxiliary;
    } & ({ low: Auxiliary; ratio?: never } | { low?: never; ratio?: number }))
  | ({ type: "impostor"; draw?: ImpostorMeshOptions } & BakeImpostorOptions)
  | { type: "empty"; maxPixels: number };

/** Derived or authored levels, finest first. Computed geometry and baked results are persisted. */
export type LevelRequest = (DerivedLevel & { source?: never }) | { type: Exclude<Kind, "empty">; source: Factory; maxPixels: number };

interface Presentation {
  levels?: readonly LevelRequest[];
  /** Recreate every procedural mesh material from its name and userData. Materials and textures are never serialized. */
  material?: MaterialResolver;
  /** Restore runtime materials/effects after persistence, before draws compile. Does not change baked content or bounds. */
  restore?: (object: Object3D, index: number) => void | Promise<void>;
}

/** Keys must include every procedural and auxiliary input. Referenced sources load only when a mesh level is demanded. */
export type LodRequest =
  | string
  | ({ url: string } & Presentation)
  | ({
      source: Factory;
      key: Dependencies;
      type?: Exclude<Kind, "empty">;
      /** The factory selects an original asset: reference it instead of persisting a copy. */
      reference?: boolean;
    } & Presentation);
const DEFAULT_LEVELS: readonly LevelRequest[] = [{ type: "impostor" }];
interface Part {
  request: LevelRequest;
  low?: Object3D;
  interior?: Object3D;
}

/**
 * Persist computed levels; warm mesh levels share their original source materials. URL sources
 * use the manager's handler, otherwise GLTFLoader. Register GLTSLoader for .glts;
 * its scene.source imports are remembered without executing scripts on warm loads.
 */
export class LodLoader extends Loader<Lod, LodRequest> {
  private sourceGltf: GLTFLoader | undefined;

  constructor(
    manager?: LoadingManager,
    private readonly cacheOptions?: LodCacheOptions,
  ) {
    super(manager);
  }

  override load(request: LodRequest, onLoad: (lod: Lod) => void, _onProgress?: (event: ProgressEvent) => void, onError?: (error: unknown) => void): void {
    this.loadAsync(request).then(onLoad, onError ?? ((error: unknown) => console.error(error)));
  }

  /** Load the coarsest drawable level eagerly; finer levels load on demand. */
  override async loadAsync(request: LodRequest): Promise<Lod> {
    const levels = await this.loadLevelsAsync(request);
    const coarse = [...levels].reverse().find(({ object }) => !boundingBox(object).isEmpty());
    if (!coarse) throw new Error("LodLoader: ladder has no drawable level");
    if (coarse.object instanceof LazyLevel) {
      const placeholder = coarse.object;
      const object = await placeholder.load();
      object.applyMatrix4(placeholder.matrix);
      const index = levels.indexOf(coarse);
      levels[index] = { object, maxPixels: coarse.maxPixels };
    }
    return new Lod(levels);
  }

  /** Cached drawable levels stay lazy, including the source. Supply an eager fallback when composing them into a Lod. */
  async loadLevelsAsync(request: LodRequest): Promise<LodLevel[]> {
    const input = typeof request === "string" ? { url: request } : request;
    const levels = (input.levels ?? DEFAULT_LEVELS).map((level) =>
      level.type === "impostor" && !level.source ? { ...level, draw: level.draw && { ...level.draw } } : { ...level },
    );
    if (levels.filter((level) => level.type === "baked" && !level.source && level.interior !== undefined).length > 1)
      throw new Error("LodLoader: give an interior to one baked level only: the source shows one");
    const url = "url" in input ? LoaderUtils.resolveURL(input.url, this.path) : undefined;
    const base = url === undefined ? this.path : LoaderUtils.extractUrlBase(url);
    const dependencies: Dependencies = "key" in input ? structuredClone(input.key) : { source: { url: LoaderUtils.resolveURL(input.url, this.path) } };
    const auxiliaries: Record<string, { url: string }> = {};
    levels.forEach((level, index) => {
      if (level.type !== "baked" || level.source) return;
      for (const name of ["low", "interior"] as const) {
        const value = level[name];
        if (typeof value === "string") auxiliaries[`auxiliary:${index}:${name}`] = { url: LoaderUtils.resolveURL(value, base) };
      }
    });
    const options = this.cacheOptions && structuredClone(this.cacheOptions);
    const recipe: Recipe = {
      levels,
      material: input.material,
      type: "type" in input ? input.type : undefined,
      reference: "url" in input || input.reference === true,
    };
    const inputs = { ...dependencies, ...auxiliaries };
    const provenance = new Provenance([...(url === undefined ? [] : [url]), ...Object.values(auxiliaries).map((input) => input.url)], options);
    const item = url ?? `LodLoader:${JSON.stringify(dependencies)}`;
    this.manager.itemStart(item);
    try {
      await provenance.load();
      const known = provenance.known ? provenance.dependencies(inputs) : undefined;
      const lookup = known && entryFor(known, recipe, options);
      const bytes = await lookup?.load();
      if (bytes !== undefined && known)
        return decode(
          bytes,
          async () => {
            const source = "source" in input ? await input.source() : await this.loadSource(LoaderUtils.resolveURL(input.url, this.path), provenance);
            for (const level of levels) {
              if (level.type !== "baked" || level.source || !level.interior) continue;
              source.add(
                typeof level.interior === "function" ? await level.interior() : await this.loadSource(LoaderUtils.resolveURL(level.interior, base), provenance),
              );
            }
            return source;
          },
          async (index) => {
            const payload = await entryFor(known, recipe, options, index).load();
            if (payload === undefined) throw new Error(`LodLoader: cached level ${index} is missing`);
            return payload;
          },
          input.restore,
          input.material,
        );
      const source = "source" in input ? await input.source() : await this.loadSource(LoaderUtils.resolveURL(input.url, this.path), provenance);
      return await this.persist(source, recipe, input.restore, base, inputs, provenance, options);
    } catch (error) {
      this.manager.itemError(item);
      throw error;
    } finally {
      this.manager.itemEnd(item);
    }
  }

  private async persist(
    source: Object3D,
    recipe: Recipe,
    restore: Presentation["restore"],
    base: string,
    inputs: Dependencies,
    provenance: Provenance,
    options?: LodCacheOptions,
  ): Promise<LodLevel[]> {
    const built = [source];
    const parts: Part[] = recipe.levels.map((request) => ({ request }));
    try {
      rejectSkinned(source, "LodLoader");
      const load = (value: Auxiliary | undefined) =>
        typeof value === "function" ? value() : value === undefined ? undefined : this.loadSource(LoaderUtils.resolveURL(value, base), provenance);
      for (const part of parts) {
        if (part.request.type !== "baked" || part.request.source) continue;
        part.low = await load(part.request.low);
        part.interior = await load(part.request.interior);
      }
      // Capture discovered imports before baking, so edits during a build reject its save.
      const resolved = provenance.dependencies(inputs);
      const entry = entryFor(resolved, recipe, options);
      await entry.load();
      for (const part of parts) built.push(await this.build(source, part));
      for (const part of parts) if (part.interior) source.add(part.interior);
      const levels: Level[] = [];
      built.forEach((object, index) => levels.push(new Level(object, index, isLOD(object), levels)));
      estimate(levels, measureLevels(built, "LodLoader").own.radius * 2);
      recipe.levels.forEach((request, index) => {
        const level = levels[index + 1];
        if (!level) throw new Error("LodLoader: missing built level");
        if (request.maxPixels !== undefined) level.maxPixels = request.maxPixels;
      });
      validate(levels);
      const encoded = await encode(
        built,
        [recipe.reference ? "source" : (recipe.type ?? "mesh"), ...recipe.levels.map((level) => level.type)],
        levels.map((level) => level.maxPixels),
        recipe.material,
      );
      for (const level of encoded.levels) {
        const payload = entryFor(resolved, recipe, options, level.index);
        await payload.load();
        await payload.save(level.bytes);
      }
      // Publish only after every deferred payload is available.
      await entry.save(encoded.index);
      await provenance.save();
      if (restore) for (const [index, object] of built.entries()) await restore(object, index);
      return levels;
    } catch (error) {
      for (const part of parts) if (part.interior && part.interior.parent !== source) disposeTree(part.interior);
      for (const object of built) disposeTree(object);
      throw error;
    } finally {
      for (const part of parts) if (part.low) disposeTree(part.low);
    }
  }

  private async build(source: Object3D, { request, low, interior }: Part): Promise<Object3D> {
    if (request.source) return request.source();
    switch (request.type) {
      case "empty":
        return new Group();
      case "mesh":
        return simplify(source, { ratio: request.ratio });
      case "impostor": {
        const { type: _, draw, ...options } = request;
        const object = new ImpostorMesh(await bakeImpostor(source, options), 1, draw);
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

  private async loadSource(url: string, provenance: Provenance): Promise<Object3D> {
    const extension = /\.(glb|gltf|glts)$/i.exec(url.split(/[?#]/)[0] ?? "")?.[1]?.toLowerCase();
    if (!extension) throw new Error(`LodLoader: cannot load "${url}": expected a .glb, .gltf or .glts file`);
    const handler = this.manager.getHandler(url);
    if (!handler && extension === "glts") throw new Error(`LodLoader: cannot load "${url}": register a GLTSLoader for .glts on the loading manager`);
    let object: Object3D;
    if (handler) object = sceneOf(await handler.loadAsync(url), url);
    else {
      this.sourceGltf ??= gltfLoader(this.manager);
      const decoder = this.sourceGltf.setCrossOrigin(this.crossOrigin).setWithCredentials(this.withCredentials).setRequestHeader(this.requestHeader);
      object = (await decoder.loadAsync(url)).scene;
    }
    try {
      provenance.capture(url, object);
      return object;
    } catch (error) {
      disposeTree(object);
      throw error;
    }
  }
}

function sceneOf(result: unknown, url: string): Object3D {
  if (isObject3D(result)) return result;
  const scene: unknown = typeof result === "object" && result !== null ? Reflect.get(result, "scene") : undefined;
  if (isObject3D(scene)) return scene;
  throw new Error(`LodLoader: the handler for "${url}" did not load an Object3D or a glTF`);
}

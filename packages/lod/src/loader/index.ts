import { Box3, Group, Loader, LoadingManager, Vector3, type Material, type Object3D, type WebGPURenderer } from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { CacheEntryOptions, Input } from "vitecache";
import { at } from "../at.js";
import { createBakeRenderer } from "../bake.js";
import { disposeRecursive } from "../dispose.js";
import { framePixels } from "../impostor/impostor.js";
import { resolveThresholds, type LodLevel } from "../levels/index.js";
import { meshoptDecoder } from "../meshopt.js";
import { isMesh, isObject3D, rejectSkinned } from "../three.js";
import { buildLevel } from "./build.js";
import { LodLoadContext } from "./context.js";
import { entryOf } from "./entry.js";
import { decodeLevel, encodeLevel, encodeShape, placedBox, readLevel, readShape, shapeOf, type Entry } from "./level.js";
import { auxiliary, derived, normalize, type Ladder, type LodRequest } from "./request.js";
import { assetPath } from "./url.js";

// The loader: it describes a ladder of levels from a source, builds each level when first loaded and stores it.

export interface CachedLodLoaderOptions extends Pick<CacheEntryOptions, "basePath" | "root"> {
  /**
   * Apply runtime effects when a level arrives, before draws compile. Does not change built content or bounds.
   * `index` is the returned ladder's: 0 is the source, and `levels[i]` arrives as `i + 1`. Set `castShadow` and
   * `shadowSide` here: a level compiles its draws, shadow maps' included, before it arrives, so a shadow setting
   * changed later compiles mid-frame.
   */
  onLevel?: (object: Object3D, index: number) => void | Promise<void>;
}

/**
 * Loads levels of detail from asset URLs, storing each derived level, and the source's shape, in vitecache, keyed by
 * the request alone. Load it as a vitecache cached loader, with literal requests, so that the vitecache plugin finds
 * every load and builds its levels in Node, saving them with the files they were built from; browsers read them, and
 * one that misses builds the level itself.
 *
 * Loads asset URLs through manager handlers, else with a GLTFLoader of its own, which decodes meshopt only: register
 * a GLTFLoader configured with Draco or KTX2 decoders for models compressed with them, and a GLTSLoader for .glts
 * sources. Impostor and interior bakes draw with a renderer of the loader's own, made at its first bake: `dispose`
 * frees it.
 */
export class CachedLodLoader extends Loader<LodLevel[], LodRequest> {
  private gltf: GLTFLoader | undefined;
  /**
   * The renderer this loader bakes with, made at its first bake. Its own, not the app's: a canvas the size of a bake
   * frame would draw that frame over the whole target (see `bakeImpostor`).
   */
  private renderer: Promise<WebGPURenderer> | undefined;
  /** Whether `loadAsync` builds every level with the ladder rather than when a camera first needs it. */
  protected readonly buildsAll: boolean = false;

  constructor(
    manager?: LoadingManager,
    private readonly options: CachedLodLoaderOptions = {},
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
   * Describes the ladder from its source, which the first level loaded then takes. Empty levels load with it, as does
   * the source when it is the only drawable; other levels load when a camera needs them, including a coarse stand-in
   * while its first detail arrives, and each derived level is built when first loaded. A level whose default threshold
   * is measured from it is built with the ladder.
   *
   * What the levels load is freed when the last Lod holding them is disposed (see `LodLevel.hold`), which spends them:
   * a Lod made from them later throws, so call loadAsync again. Levels no Lod ever holds are never freed: they are
   * yours until a Lod holds them.
   */
  override async loadAsync(request: LodRequest): Promise<LodLevel[]> {
    const ladder = normalize(request, this.path);
    const { url, levels: requests } = ladder;
    const context = new LodLoadContext(() => this.loadAsset(url), this.options.onLevel);
    this.manager.itemStart(url);
    try {
      // A simplified or baked level's default threshold is measured from its deviation, so it is built with the ladder.
      const eager = requests.flatMap((level, index) =>
        level.type !== "empty" && (this.buildsAll || (level.type !== "impostor" && level.maxPixels === undefined)) ? [index + 1] : [],
      );
      // Only what measures a default threshold: bytes no camera asked for are not held.
      const measured = new Map<number, Entry["level"]>();
      for (const index of eager) {
        let built = false;
        const level = await this.cached(ladder, index, async () => {
          built = true;
          return this.build(ladder, index, await context.source());
        });
        // A level built here is handed to its first load; a stored one is read again then.
        if (built) context.setBuilt(index, level);
        measured.set(index, readLevel(level).level);
      }
      const shape = readShape(await this.cached(ladder, "shape", async () => encodeShape(shapeOf(await context.source()))));
      const box = placedBox(shape);
      if (box.isEmpty()) throw new Error("CachedLodLoader: the source has no visible geometry to measure");
      const thresholds = resolveThresholds(
        [
          {},
          ...requests.map((level, position) => ({
            // An impostor's default is its frame's, whether or not it is built with the ladder.
            maxPixels: level.maxPixels ?? (level.type === "impostor" ? framePixels(level.resolution) : undefined),
            measured: level.type === "impostor" ? undefined : measured.get(position + 1),
          })),
        ],
        shape.box.getSize(new Vector3()).length(),
        "CachedLodLoader",
      );
      const { hold } = context;
      // Every load runs once however often it is asked for: every Lod made from the levels and the levels reading the
      // source's materials share one object. The source's starts synchronously, so it takes the spare before a coarser
      // level demanded in the same tick.
      const loadSource = once(async () => context.arrive(context.take() ?? (await this.loadAsset(url)), 0, { materials: true }));
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

  /** The stored bytes of derived level `of`, or of the source's shape, else what `build` makes, saved. */
  private async cached(ladder: Ladder, of: number | "shape", build: () => Promise<Uint8Array>): Promise<Uint8Array> {
    const entry = entryOf(ladder, of, this.options);
    const stored = await entry.load();
    if (stored) return stored;
    const bytes = await build();
    await entry.save(bytes, { dependencies: this.inputs() });
    return bytes;
  }

  /** The files and packages what this loader built so far was built from: none in browsers, which do not save. */
  protected inputs(): Input[] {
    return [];
  }

  /** A deferred level's bytes, built from `spare`, the ladder's source, or from a source of its own. Disposes `spare` either way. */
  private async levelBytes(ladder: Ladder, index: number, spare: Object3D | undefined): Promise<Uint8Array> {
    let used = false;
    const bytes = await this.cached(ladder, index, async () => {
      used = true;
      const source = spare ?? (await this.loadAsset(ladder.url));
      try {
        return await this.build(ladder, index, source);
      } finally {
        disposeRecursive(source);
      }
    });
    if (spare && !used) disposeRecursive(spare);
    return bytes;
  }

  /** Build level `index` from `source`, encoded. */
  private async build(ladder: Ladder, index: number, source: Object3D): Promise<Uint8Array> {
    const { urls } = ladder;
    const request = derived(ladder.levels, index);
    const load = (name: "low" | "interior") => {
      const asset = urls[auxiliary(index, name)];
      return asset === undefined ? undefined : this.loadAsset(asset);
    };
    let low: Object3D | undefined, interior: Object3D | undefined, built: Object3D | undefined;
    try {
      rejectSkinned(source, "CachedLodLoader");
      low = await load("low");
      interior = await load("interior");
      built = await buildLevel(source, request, { low, interior }, () => this.bakeRenderer());
      return await encodeLevel(built, request.type, shapeOf(source), materialsOf(source));
    } finally {
      for (const object of [interior, low]) if (object) disposeRecursive(object);
      // A simplified level draws with the source's materials, which are freed with the source.
      if (built) disposeRecursive(built, { materials: request.type !== "simplify" });
    }
  }

  /** The renderer this loader bakes with, made at its first bake. */
  private bakeRenderer(): Promise<WebGPURenderer> {
    this.renderer ??= this.newBakeRenderer();
    return this.renderer;
  }

  protected newBakeRenderer(): Promise<WebGPURenderer> {
    return createBakeRenderer();
  }

  /**
   * Free the renderer this loader made for its bakes, resolving once freed; a bake under way fails. Levels it loaded
   * stay as they are, and a later bake makes a new renderer.
   */
  async dispose(): Promise<void> {
    const renderer = this.renderer;
    this.renderer = undefined;
    // A renderer that failed to initialise failed the bake that made it.
    const made = await renderer?.catch(() => undefined);
    made?.dispose();
  }

  private async loadAsset(url: string): Promise<Object3D> {
    const { path, extension } = assetPath(url);
    const handler = this.manager.getHandler(path);
    if (!handler && extension === "glts") throw new Error(`CachedLodLoader: cannot load "${url}": register a GLTSLoader for .glts on the loading manager`);
    let result: unknown;
    if (handler) result = await handler.loadAsync(url);
    else {
      this.gltf ??= new GLTFLoader(this.manager).setMeshoptDecoder(meshoptDecoder());
      const decoder = this.gltf.setCrossOrigin(this.crossOrigin).setWithCredentials(this.withCredentials).setRequestHeader(this.requestHeader);
      result = await decoder.loadAsync(url);
    }
    return objectOf(result, url);
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
  throw new Error(`CachedLodLoader: the handler for "${url}" did not load an Object3D or a glTF`);
}

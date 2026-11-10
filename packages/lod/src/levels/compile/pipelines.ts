import type { Material, Mesh, Renderer } from "three/webgpu";
import type { RenderContext } from "./contexts.js";

interface Pipelines {
  getForRender(object: unknown, promises?: Promise<unknown>[] | null): unknown;
}

/** The next frame. */
export const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const isPipelines = (value: unknown): value is Pipelines =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "getForRender") === "function";

/**
 * r186 caches a pipeline before it finishes, but a compile reusing it receives none of its promises. Share that
 * pipeline's readiness, not the readiness of every earlier level: wrap r186's `_pipelines.getForRender`, as no public
 * API tells when a cached pipeline is ready. Installed once per renderer, by its LodGpu. The adapter
 * follows the renderer's pipeline cache lifetime; pending entries disappear on success or failure and otherwise hold no
 * completed pipelines.
 */
export function sharePipelines(renderer: Renderer): void {
  const pipelines: unknown = Reflect.get(renderer, "_pipelines");
  if (!isPipelines(pipelines)) throw new Error("Lod: three's renderer keeps no render pipelines (lod mirrors r186)");
  if (Reflect.get(pipelines.getForRender, SHARED) === true) return;
  const get = pipelines.getForRender;
  const pending = new WeakMap<object, Promise<void>>();
  pipelines.getForRender = (object, promises) => {
    const before = promises?.length ?? 0;
    const pipeline = get.call(pipelines, object, promises);
    if (!promises) return pipeline;
    if (typeof pipeline !== "object" || pipeline === null) throw new Error("Lod: three returned no render pipeline");
    let ready = pending.get(pipeline);
    if (!ready) {
      ready = pipelineReady(renderer, pipeline, promises.slice(before));
      pending.set(pipeline, ready);
      const clear = () => pending.delete(pipeline);
      void ready.then(clear, clear);
    }
    promises.push(ready);
    return pipeline;
  };
  Reflect.set(pipelines.getForRender, SHARED, true);
}

/** Marks the wrapped getForRender: a second LodGpu of the renderer shares its pipelines already. */
const SHARED = Symbol("lodSharedPipelines");

/**
 * A cached pipeline may have been started by the host before the adapter was installed: wait until the backend's data
 * for it holds a pipeline or an error. r186's `_isDeviceLost` is read as no public API tells a lost device.
 */
async function pipelineReady(renderer: Renderer, pipeline: object, started: readonly Promise<unknown>[]): Promise<void> {
  await Promise.all(started);
  const get: unknown = Reflect.get(renderer.backend, "get");
  if (typeof get !== "function") throw new Error("Lod: three's backend keeps no pipeline data");
  for (;;) {
    const data: unknown = Reflect.apply(get, renderer.backend, [pipeline]);
    if (typeof data !== "object" || data === null) throw new Error("Lod: three's backend has no render pipeline data");
    if (Reflect.get(data, "error") === true) throw new Error("Lod: render pipeline compilation failed");
    if (Reflect.get(renderer, "_isDeviceLost") === true) throw new Error("Lod: device lost while compiling a render pipeline");
    if (Reflect.get(data, "pipeline")) return;
    await frame();
  }
}

/** What a level's draws are compiled for: the camera's draw, or a shadow map's with the material three overrides with. */
export interface CompileTarget {
  context: RenderContext;
  overrideMaterial: Material | null;
}

/**
 * What r186's renderObject gives an override material for one draw, and puts back once it has handed the draw on.
 * This and `DRAWN` mirror three 0.186.1's Renderer.renderObject; a three that sets other keys builds shadow shaders
 * in the frame again.
 */
const DRAW_STATE = ["colorNode", "depthNode", "positionNode", "side", "displacementMap", "displacementScale", "displacementBias"];
/** The keys a draw adds to an override material that lacks them, in the order it adds them. */
const DRAWN = ["alphaMap", "displacementMap", "displacementScale", "displacementBias"];

/**
 * A copy of the shadow map's override material for compiling one draw. r186's compileAsync builds the draw only after
 * renderObject has put back the per-draw state it gave the override (the caster's shadow nodes and side), so with the
 * shared material it would prepare a pipeline the shadow map never draws with. The copy holds the state of the draw.
 * It is not disposed: that would release the pipeline before the shadow map draws with it.
 */
function keepingDrawState(material: Material): Material {
  const copy = material.clone();
  // The build's cache key lists a material's keys in order. clone() leaves out those three adds to its shadow material,
  // its flag and those its draws set, which the copy gets in the order the shared material has them once it drew.
  for (const key of [...Object.keys(material), ...DRAWN])
    if (!key.startsWith("_") && !Object.hasOwn(copy, key)) Reflect.set(copy, key, Reflect.get(material, key) ?? null);
  for (const key of DRAW_STATE) {
    let value: unknown = Reflect.get(copy, key);
    let given = false;
    Object.defineProperty(copy, key, {
      get: () => value,
      set: (next: unknown) => {
        if (given) return;
        given = true;
        value = next;
      },
    });
  }
  return copy;
}

export function compileMesh(renderer: Renderer, mesh: Mesh, { context, overrideMaterial }: CompileTarget): Promise<void> {
  const { camera, scene } = context;
  const target = renderer.getRenderTarget();
  const mrt = renderer.getMRT();
  const cubeFace = renderer.getActiveCubeFace();
  const mipLevel = renderer.getActiveMipmapLevel();
  const culled = mesh.frustumCulled;
  const visible = mesh.visible;
  const children = mesh.children;
  const background = scene.background;
  const backgroundNode = scene.backgroundNode;
  const override = scene.overrideMaterial;
  try {
    renderer.setRenderTarget(context.target, context.cubeFace, context.mipLevel);
    renderer.setMRT(context.mrt);
    scene.overrideMaterial = overrideMaterial && keepingDrawState(overrideMaterial);
    // Demanded levels can still be hidden or outside the last camera's frustum.
    mesh.frustumCulled = false;
    mesh.visible = true;
    mesh.children = [];
    // r186 compiles backgrounds first, which would postpone this mesh until after renderer state is restored.
    scene.background = null;
    scene.backgroundNode = null;
    return atDepth(renderer, context.depth, () => renderer.compileAsync(mesh, camera, scene));
  } finally {
    scene.background = background;
    scene.backgroundNode = backgroundNode;
    scene.overrideMaterial = override;
    mesh.children = children;
    mesh.frustumCulled = culled;
    mesh.visible = visible;
    renderer.setRenderTarget(target, cubeFace, mipLevel);
    renderer.setMRT(mrt);
  }
}

/** three's render contexts, which a compile takes at depth 0. */
interface RenderContexts {
  get(target: unknown, mrt: unknown, depth?: number): unknown;
}

const isRenderContexts = (value: unknown): value is RenderContexts =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "get") === "function";

/**
 * Run `compile`, which starts a compileAsync, so that it prepares draws for renders `depth` deep. Mirrors three r186
 * (0.186.1): compileAsync takes its render context, as a render of its own, with the first `_renderContexts.get` of
 * its synchronous start. Only that call is given `depth`; renders the compile starts meanwhile take their own. A three
 * that no longer makes that call fails here rather than compiling for the wrong depth. No public API compiles for a
 * depth other than 0.
 */
export function atDepth(renderer: Renderer, depth: number, compile: () => Promise<void>): Promise<void> {
  if (depth === 0) return compile();
  const contexts: unknown = Reflect.get(renderer, "_renderContexts");
  if (!isRenderContexts(contexts)) throw new Error("Lod: three's renderer keeps no render contexts");
  const own = Object.hasOwn(contexts, "get");
  const get = contexts.get;
  let taken = false;
  const restore = () => {
    if (own) contexts.get = get;
    else Reflect.deleteProperty(contexts, "get");
  };
  contexts.get = (target, mrt) => {
    taken = true;
    restore();
    return get.call(contexts, target, mrt, depth);
  };
  let result: Promise<void>;
  try {
    result = compile();
  } finally {
    if (!taken) restore();
  }
  // compileAsync returns at once on a lost device, which is no fault of three's version; r186's `_isDeviceLost` alone
  // tells it.
  if (taken || Reflect.get(renderer, "_isDeviceLost") === true) return result;
  void result.catch(() => {});
  throw new Error("Lod: three's compileAsync took no render context as it started (lod mirrors three r186)");
}

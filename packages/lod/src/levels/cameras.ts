import { Vector2, Vector4, type Camera, type Renderer, type Scene } from "three/webgpu";
import { at } from "../at.js";
import { busy } from "./renderer.js";
import { renderNow, sameContext, type RenderContext, type ShadowMap, type Target } from "./compile/contexts.js";

// What renders tell a Lod of the cameras that draw it.

const viewport = new Vector4();
const canvas = new Vector2();

/**
 * The height `renderer` draws at now, which levels are chosen at: CSS pixels on the canvas, so that a high-density
 * screen picks the levels a standard one does and pays for its extra pixels only in fill; pixels in a render target,
 * except one the canvas's size, which stands in for it (a post-processing target); in a shadow pass, the map's texels.
 */
export function drawingHeight(renderer: Renderer, shadow: boolean): number | null {
  const active = renderer.getRenderTarget();
  if (shadow) return active ? active.height : null;
  if (!active) return renderer.getViewport(viewport).w;
  const ratio = active.height === renderer.getDrawingBufferSize(canvas).y ? renderer.getPixelRatio() : 1;
  return active.viewport.w / ratio;
}

/** What renders told of a camera: the height it last drew at, its render contexts, and the shadow maps it drew. */
interface CameraState {
  height: number | null;
  /**
   * Its render contexts, the one it last rendered in first. A context stays the same object while what it describes
   * does, so what was compiled for it stays compiled when the camera renders other scenes or targets between.
   */
  contexts: RenderContext[];
  /** The shadow maps it drew, as a light's shadow camera: an arriving caster's draws are compiled for them too. */
  shadows: ShadowMap[];
}

/** The render contexts kept per camera: those of a camera that draws several scenes or targets each frame. */
const CONTEXTS = 8;

/**
 * What a Lod's renders told of each camera that drew it: the height it draws at, where it rendered, and the shadow
 * maps it drew. A context or shadow map whose target is disposed is passed over, so that no compile revives the target.
 */
export class CameraRenders {
  /** Per camera: a side table, as three's Camera has no place for a package's state; a camera let go is let go here. */
  private readonly cameras = new WeakMap<Camera, CameraState>();
  /** The targets disposed since they were last drawn into. */
  private readonly disposed = new WeakSet<Target>();
  /** One listener on each target drawn into, until it is disposed or `dispose` is called. */
  private readonly listeners = new Map<Target, () => void>();

  /**
   * The height `camera` draws at, measured from `renderer` while it renders (see `drawingHeight`), else the last it
   * drew at; before it drew, the canvas's.
   */
  heightOf(camera: Camera, renderer: Renderer, shadow: boolean): number {
    const height = busy(renderer) ? drawingHeight(renderer, shadow) : null;
    if (height !== null) this.stateOf(camera).height = height;
    return this.cameras.get(camera)?.height ?? renderer.getSize(canvas).y;
  }

  /** Where `camera` last rendered a scene holding the Lod, into a target not disposed. */
  contextOf(camera: Camera): RenderContext | undefined {
    return this.cameras.get(camera)?.contexts.find((context) => !this.isDisposed(context.target));
  }

  /**
   * Whether `context` is still one its camera renders in: not one whose target was disposed, nor one evicted by the
   * cap on contexts per camera.
   */
  holds(context: RenderContext): boolean {
    return !this.isDisposed(context.target) && (this.cameras.get(context.camera)?.contexts.includes(context) ?? false);
  }

  /** The shadow maps `cameras` drew, into targets not disposed. */
  shadowsOf(cameras: Iterable<Camera>): ShadowMap[] {
    return [...cameras].flatMap((camera) => this.cameras.get(camera)?.shadows ?? []).filter((map) => !this.isDisposed(map.target));
  }

  /** Whether `camera`, a light's shadow camera, drew a shadow map whose target is not disposed. */
  drawsShadowMap(camera: Camera): boolean {
    return this.cameras.get(camera)?.shadows.some((map) => !this.isDisposed(map.target)) ?? false;
  }

  /**
   * Whether `target` was disposed since it was last drawn into: what draws into it compiles nothing. The output never
   * is.
   */
  isDisposed(target: RenderContext["target"]): boolean {
    return target !== null && this.disposed.has(target);
  }

  /** Note what `renderer` rendering `scene` with `camera` tells: the camera's render context, or a shadow map. */
  note(renderer: Renderer, scene: Scene, camera: Camera): void {
    const now = renderNow(renderer, scene, camera);
    if (!now) return;
    const state = this.stateOf(camera);
    if ("shadow" in now) {
      const { shadow } = now;
      this.drawnInto(shadow.target);
      const index = state.shadows.findIndex((map) => map.target === shadow.target);
      if (index >= 0) state.shadows[index] = shadow;
      else state.shadows.push(shadow);
      return;
    }
    const { contexts } = state;
    const { target } = now.context;
    if (target) this.drawnInto(target);
    const index = contexts.findIndex((context) => sameContext(context, now.context));
    contexts.unshift(index >= 0 ? at(contexts.splice(index, 1), 0) : now.context);
    if (contexts.length > CONTEXTS) contexts.pop();
  }

  /** Stop listening to the targets drawn into. */
  dispose(): void {
    for (const [target, listener] of this.listeners) target.removeEventListener("dispose", listener);
    this.listeners.clear();
  }

  /** `target` is drawn into now: live again if it was disposed, and listened to for its disposal. */
  private drawnInto(target: Target): void {
    this.disposed.delete(target);
    if (this.listeners.has(target)) return;
    const listener = () => {
      this.disposed.add(target);
      target.removeEventListener("dispose", listener);
      this.listeners.delete(target);
    };
    this.listeners.set(target, listener);
    target.addEventListener("dispose", listener);
  }

  private stateOf(camera: Camera): CameraState {
    let state = this.cameras.get(camera);
    if (!state) this.cameras.set(camera, (state = { height: null, contexts: [], shadows: [] }));
    return state;
  }
}

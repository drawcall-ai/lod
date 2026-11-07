import { Vector2, Vector3, Vector4, type Camera, type Material, Matrix4, Frustum, Sphere, type Renderer, type Scene } from "three/webgpu";
import { at } from "./at.js";
import { inShadowPass, isOutputPass } from "./three.js";

const scratch = new Vector3();

/**
 * The angle `sphere` (in the space `root` maps to world) subtends from `eye`, small-angle:
 * its diameter, scaled by the largest axis scale of `root`, over its distance.
 */
export function subtense(root: Matrix4, sphere: Sphere, eye: Vector3): number {
  const centre = scratch.copy(sphere.center).applyMatrix4(root);
  return (2 * sphere.radius * root.getMaxScaleOnAxis()) / Math.max(eye.distanceTo(centre), 1e-6);
}

/** How a camera measures objects on screen: from where, and pixels per unit of subtense (or of size, orthographic). */
export class View {
  readonly eye = new Vector3();
  ortho = false;
  scale = 0;
  /** Whether levels fade (not with an orthographic camera or a forced level). */
  fades = false;

  /** Read `camera`, drawing into a viewport `height` pixels tall. */
  begin(camera: Camera, height: number, forceLevel: number | null): this {
    const projection = camera.projectionMatrix.elements;
    this.ortho = projection[15] === 1;
    this.scale = ((projection[5] ?? 0) * height) / 2;
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    this.fades = forceLevel === null && !this.ortho;
    return this;
  }

  /** On-screen height of `sphere`, given in the space `root` maps to world. */
  pixels(root: Matrix4, sphere: Sphere): number {
    const size = this.ortho ? 2 * sphere.radius * root.getMaxScaleOnAxis() : subtense(root, sphere, this.eye);
    return size * this.scale;
  }
}

const viewport = new Vector4();
const canvas = new Vector2();

/**
 * The viewport height each camera renders at: CSS pixels on the canvas, so that a high-density screen picks the levels
 * a standard one does and pays for its extra pixels only in fill; pixels in a render target, except one the canvas's
 * size, which stands in for it (a post-processing pass).
 */
const heights = new WeakMap<Camera, number>();

export interface RenderContext {
  renderer: Renderer;
  camera: Camera;
  scene: Scene;
  /** The target the render was asked for: null for the output, also while three draws it through its output pass. */
  target: ReturnType<Renderer["getRenderTarget"]>;
  mrt: Parameters<Renderer["setMRT"]>[0];
  cubeFace: number;
  mipLevel: number;
  /** How deep in renders it drew (see `callDepth`). */
  depth: number;
}

/**
 * Each camera's render contexts, the one it last rendered in first. A context stays the same object while what it
 * describes does, so what was prepared for it stays prepared when the camera renders other scenes or targets between.
 */
const contexts = new WeakMap<Camera, RenderContext[]>();
const CONTEXTS = 8;
/** Where `camera` last rendered a scene holding an owner: levels it needs are prepared for that. */
export const renderContext = (camera: Camera): RenderContext | undefined => contexts.get(camera)?.[0];

/** A shadow map rendered for a scene, with the camera and override material three drew it with. */
export interface ShadowPass {
  renderer: Renderer;
  camera: Camera;
  target: NonNullable<RenderContext["target"]>;
  material: Material;
  depth: number;
}

const shadowPasses = new WeakMap<Scene, Map<ShadowPass["target"], ShadowPass>>();

/** The shadow maps rendered for `scene`, which an arriving caster's draws are prepared for too. */
export const shadowPassesOf = (scene: Scene): ShadowPass[] => [...(shadowPasses.get(scene)?.values() ?? [])];

/**
 * Learn what `renderer` rendering `scene` with `camera` tells its owners: the camera's render context and viewport
 * height, or a shadow map, whose camera measures in its texels.
 */
export function recordRender(renderer: Renderer, scene: Scene, camera: Camera): void {
  const active = renderer.getRenderTarget();
  const material = scene.overrideMaterial;
  if (inShadowPass(scene)) {
    if (!active || !material) return;
    let passes = shadowPasses.get(scene);
    if (!passes) shadowPasses.set(scene, (passes = new Map()));
    passes.set(active, { renderer, camera, target: active, material, depth: callDepth(renderer) });
    heights.set(camera, active.height);
    return;
  }
  const target = isOutputPass(active) ? null : active;
  const mrt = renderer.getMRT();
  const cubeFace = renderer.getActiveCubeFace();
  const mipLevel = renderer.getActiveMipmapLevel();
  const depth = callDepth(renderer);
  let list = contexts.get(camera);
  if (!list) contexts.set(camera, (list = []));
  const index = list.findIndex(
    (context) =>
      context.renderer === renderer &&
      context.scene === scene &&
      context.target === target &&
      context.mrt === mrt &&
      context.cubeFace === cubeFace &&
      context.mipLevel === mipLevel &&
      context.depth === depth,
  );
  const context = index >= 0 ? at(list.splice(index, 1), 0) : { renderer, camera, scene, target, mrt, cubeFace, mipLevel, depth };
  // A few: those of a camera that draws several scenes or targets each frame.
  list.unshift(context);
  if (list.length > CONTEXTS) list.pop();
  if (!active) return void heights.set(camera, renderer.getViewport(viewport).w);
  const ratio = active.height === renderer.getDrawingBufferSize(canvas).y ? renderer.getPixelRatio() : 1;
  heights.set(camera, active.viewport.w / ratio);
}

/**
 * Set the view height before the first LOD update, or after a resize before the next render. Use CSS pixels for the
 * canvas or a full-size postprocessing target; use target pixels for other render targets. Renders measure it
 * automatically.
 */
export function setViewportHeight(camera: Camera, height: number): void {
  if (!Number.isFinite(height) || height <= 0) throw new RangeError("LOD viewport height must be finite and positive");
  heights.set(camera, height);
}

/** The explicit or last rendered height, or null before either is known. */
export const viewportHeight = (camera: Camera): number | null => heights.get(camera) ?? null;

/** A typical screen's height, for a camera that rendered no scene holding an owner yet. */
export const TYPICAL_HEIGHT = 1080;

const views = new WeakMap<Camera, { projection: Matrix4; world: Matrix4; frustum: Frustum }>();
const projectionView = new Matrix4(),
  worldSphere = new Sphere();

/** Whether `sphere`, in the space `root` maps to world, meets `camera`'s frustum: a view or a shadow map needs levels only for what it sees. */
export function inView(camera: Camera, root: Matrix4, sphere: Sphere): boolean {
  if (sphere.isEmpty()) return false;
  let cached = views.get(camera);
  if (!cached) {
    cached = { projection: new Matrix4().makeScale(0, 0, 0), world: new Matrix4(), frustum: new Frustum() };
    views.set(camera, cached);
  }
  if (!cached.projection.equals(camera.projectionMatrix) || !cached.world.equals(camera.matrixWorld)) {
    cached.projection.copy(camera.projectionMatrix);
    cached.world.copy(camera.matrixWorld);
    projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    cached.frustum.setFromProjectionMatrix(projectionView, camera.coordinateSystem, camera.reversedDepth);
  }
  worldSphere.copy(sphere).applyMatrix4(root);
  return cached.frustum.intersectsSphere(worldSphere);
}

/**
 * How deep in renders `renderer` is: 0 in a render of its own, 1 in one it draws inside another, as it draws shadow
 * maps and passes. three keeps a draw's built shader per depth.
 */
export function callDepth(renderer: Renderer): number {
  const depth: unknown = Reflect.get(renderer, "_callDepth");
  return typeof depth === "number" ? Math.max(depth, 0) : 0;
}

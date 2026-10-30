import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
  Object3D,
  Vector2,
  Vector3,
  Vector4,
  type Camera,
  Matrix4,
  Frustum,
  Sphere,
  type Renderer,
  type Scene,
} from "three/webgpu";
import { gpuRenderer, inShadowPass } from "./three.js";

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
 * The viewport height each camera draws at, as the level meshes drawn with it see it: CSS
 * pixels on the canvas, so that a high-density screen picks the levels a standard one
 * does and pays for its extra pixels only in fill; pixels in a render target, except one
 * the canvas's size, which stands in for it (a post-processing pass). Every level
 * mesh that draws tells it for all: a Lod or InstancedLod with nothing drawn learns it
 * from the others.
 */
const heights = new WeakMap<Camera, number>();

export interface RenderContext {
  renderer: Renderer;
  camera: Camera;
  scene: Scene;
  target: ReturnType<Renderer["getRenderTarget"]>;
  mrt: ReturnType<Renderer["getMRT"]>;
  cubeFace: number;
  mipLevel: number;
}

const contexts = new WeakMap<Camera, RenderContext>();
export const renderContext = (camera: Camera): RenderContext | undefined => contexts.get(camera);

/**
 * Set the view height before the first LOD update, or after a resize while no level
 * meshes draw. Use CSS pixels for the canvas or a full-size postprocessing target;
 * use target pixels for other render targets. Subsequent draws measure it automatically.
 */
export function setViewportHeight(camera: Camera, height: number): void {
  if (!Number.isFinite(height) || height <= 0) throw new RangeError("LOD viewport height must be finite and positive");
  heights.set(camera, height);
}

/** The explicit or last drawn height, or null before either is known. */
export const viewportHeight = (camera: Camera): number | null => heights.get(camera) ?? null;

/** Learn the height whenever `mesh` draws. */
export function watchViewport(mesh: Mesh): void {
  const previous = mesh.onBeforeRender;
  mesh.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
    previous.call(mesh, renderer, scene, camera, geometry, material, group);
    // Shadow maps are drawn for the viewing camera's choice, not measured.
    if (inShadowPass(scene)) return;
    const gpu = gpuRenderer(renderer);
    const target = gpu.getRenderTarget();
    const mrt = gpu.getMRT();
    const cubeFace = gpu.getActiveCubeFace();
    const mipLevel = gpu.getActiveMipmapLevel();
    const context = contexts.get(camera);
    if (
      !context ||
      context.renderer !== gpu ||
      context.scene !== scene ||
      context.target !== target ||
      context.mrt !== mrt ||
      context.cubeFace !== cubeFace ||
      context.mipLevel !== mipLevel
    )
      contexts.set(camera, { renderer: gpu, camera, scene, target, mrt, cubeFace, mipLevel });
    if (!target) return void heights.set(camera, gpu.getViewport(viewport).w);
    const ratio = target.height === gpu.getDrawingBufferSize(canvas).y ? gpu.getPixelRatio() : 1;
    heights.set(camera, target.viewport.w / ratio);
  };
}

/** A typical screen's height, for a camera no level mesh drew with yet. */
export const TYPICAL_HEIGHT = 1080;

const observers = new WeakMap<Object3D, Mesh>();

/** An empty eager fallback still needs one draw callback to discover the rendering context. */
export function watchContext(root: Object3D): void {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0], 3));
  geometry.setDrawRange(0, 0);
  const mesh = new Mesh(geometry, new MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false }));
  mesh.frustumCulled = false;
  watchViewport(mesh);
  observers.set(root, mesh);
  root.add(mesh);
}

export function unwatchContext(root: Object3D): void {
  const mesh = observers.get(root);
  if (!mesh) return;
  root.remove(mesh);
  mesh.geometry.dispose();
  if (!Array.isArray(mesh.material)) mesh.material.dispose();
  observers.delete(root);
}

const views = new WeakMap<Camera, { projection: Matrix4; world: Matrix4; frustum: Frustum }>();
const projectionView = new Matrix4(),
  worldSphere = new Sphere();

/** Demand only from the viewing frustum; lazy shadow work uses the ready fallback. */
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

import { Vector2, Vector3, Vector4, type Camera, type Matrix4, type Mesh, type Sphere } from "three/webgpu";
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

/** The height `camera` last drew at, or null before any level mesh drew with it. */
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
    if (!target) return void heights.set(camera, gpu.getViewport(viewport).w);
    const ratio = target.height === gpu.getDrawingBufferSize(canvas).y ? gpu.getPixelRatio() : 1;
    heights.set(camera, target.viewport.w / ratio);
  };
}

/** A typical screen's height, for a camera no level mesh drew with yet. */
export const TYPICAL_HEIGHT = 1080;

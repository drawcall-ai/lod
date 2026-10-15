import { Vector3, Vector4, type Camera, type Matrix4, type Mesh, type Sphere } from "three";
import { subtense } from "./fade.js";

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

/** The viewport height each camera draws at, as the meshes of one Lod see it. */
export class Viewports {
  private readonly heights = new WeakMap<Camera, number>();

  /** The height `camera` last drew at; 1080 before its first frame. */
  heightOf(camera: Camera): number {
    return this.heights.get(camera) ?? 1080;
  }

  /** Learn the height whenever `mesh` draws. */
  watch(mesh: Mesh): void {
    const previous = mesh.onBeforeRender;
    mesh.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
      previous.call(mesh, renderer, scene, camera, geometry, material, group);
      this.heights.set(camera, renderer.getCurrentViewport(viewport).w);
    };
  }
}

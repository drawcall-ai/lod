import type { Camera, Mesh, WebGLRenderer } from "three";
import { isInstancedMesh } from "./three.js";

// Casters too small for a shadow map. A caster narrower than a texel of a directional
// light's (orthographic) shadow map covers at most one texel centre, and only by chance:
// drawn, it flickers as it or the map moves, and crowds of them fill the far maps of
// cascaded shadows with draws no one sees. Such a caster draws nothing into that map.
// Perspective shadow cameras (spot and point lights) cover little ground and are not
// checked.

/** World size of a texel of the shadow map `renderer` is drawing with orthographic `camera`; 0 if not orthographic. */
function texel(renderer: WebGLRenderer, camera: Camera): number {
  const projection = camera.projectionMatrix.elements;
  const height = renderer.getRenderTarget()?.height ?? 0;
  if (projection[15] !== 1 || height === 0) return 0;
  // projection[5] is 2 × zoom / (top - bottom)
  return 2 / ((projection[5] ?? 0) * height);
}

/** Draws a mesh as nothing for one shadow draw: see `skip` and `restore`. */
export class TinyCaster {
  /** The mesh's count or draw range while it draws nothing, else null. */
  private kept: number | null = null;

  /** Before `mesh` draws into a shadow map: draw nothing if a caster `diameter` wide spans less than one of its texels. */
  skip(mesh: Mesh, renderer: WebGLRenderer, shadowCamera: Camera, diameter: number): void {
    if (diameter >= texel(renderer, shadowCamera)) return;
    if (isInstancedMesh(mesh)) {
      this.kept = mesh.count;
      mesh.count = 0;
    } else {
      this.kept = mesh.geometry.drawRange.count;
      mesh.geometry.drawRange.count = 0;
    }
  }

  /** After the shadow draw: as `mesh` was. */
  restore(mesh: Mesh): void {
    if (this.kept === null) return;
    if (isInstancedMesh(mesh)) mesh.count = this.kept;
    else mesh.geometry.drawRange.count = this.kept;
    this.kept = null;
  }
}

/** Leave `mesh` out of every shadow map whose texels are wider than `diameter()`, its largest caster's diameter in world units. */
export function skipTinyShadows(mesh: Mesh, diameter: () => number): void {
  const tiny = new TinyCaster();
  const before = mesh.onBeforeShadow;
  const after = mesh.onAfterShadow;
  mesh.onBeforeShadow = (renderer, object, camera, shadowCamera, geometry, depthMaterial, group) => {
    before.call(mesh, renderer, object, camera, shadowCamera, geometry, depthMaterial, group);
    tiny.skip(mesh, renderer, shadowCamera, diameter());
  };
  mesh.onAfterShadow = (renderer, object, camera, shadowCamera, geometry, depthMaterial, group) => {
    tiny.restore(mesh);
    after.call(mesh, renderer, object, camera, shadowCamera, geometry, depthMaterial, group);
  };
}

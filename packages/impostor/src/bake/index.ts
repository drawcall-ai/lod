import {
  Box3,
  Color,
  FloatType,
  Matrix4,
  NearestFilter,
  OrthographicCamera,
  Scene,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
  type Object3D,
} from "three";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { MAPS, boundingRadius, validateImpostor, type Impostor, type ImpostorLayout, type ImpostorMap } from "../impostor.js";
import { frameBasis, frameDirection, type Vec3 } from "../octahedral.js";
import { isBatchedMesh, isInstancedMesh, isMesh } from "../three.js";
import { Atlas } from "./atlas.js";
import { swapMaterials, type BakeSettings } from "./materials.js";

export interface BakeOptions {
  /**
   * "full" (default): views from every side, so any orientation works. "hemi": views
   * from the horizon up only, for objects that always stand upright; the same quality
   * there with about 45% less memory.
   */
  layout?: ImpostorLayout;
  /** views per atlas side; default 16 for full, 12 for hemi */
  frames?: number;
  /**
   * pixels per view: the impostor stays sharp up to about this size on screen. Rounded
   * down to a power of two so mip levels never mix two views; default 128.
   */
  resolution?: number;
  /**
   * bake an emissive layer; default: when any material emits. It is stored as 0..1
   * sRGB, so emissive * emissiveIntensity above 1 is clipped.
   */
  emissive?: boolean;
  /** renders per output pixel per axis; default 2 */
  supersample?: number;
  /** reuse a renderer instead of creating a temporary one */
  renderer?: WebGLRenderer;
}

/**
 * Empty border around the object in every frame, as a fraction of the frame's half
 * size. It keeps mip levels from blending a frame's silhouette into its neighbour.
 */
const PAD = 0.06;

/**
 * Bake `object` (in its own space, ignoring its own transform) into an impostor.
 *
 * Each frame is an orthographic look at the bounding-box centre. The object's
 * materials are rendered unlit into one target per map: base colour + coverage,
 * object-space normal + depth, occlusion/roughness/metalness and, if needed, emissive.
 */
export async function bakeImpostor(object: Object3D, options: BakeOptions = {}): Promise<Impostor> {
  const layout = options.layout ?? "full";
  const frames = options.frames ?? (layout === "hemi" ? 12 : 16);
  const resolution = options.resolution ?? 128;
  const supersample = options.supersample ?? 2;
  if (!Number.isInteger(frames) || frames < 2) throw new Error("bakeImpostor: frames must be an integer >= 2");
  if (!Number.isFinite(resolution) || resolution < 4) throw new Error("bakeImpostor: resolution must be a number >= 4");
  if (!Number.isInteger(supersample) || supersample < 1) throw new Error("bakeImpostor: supersample must be an integer >= 1");
  const cell = 2 ** Math.floor(Math.log2(resolution));

  // SkeletonUtils.clone rebinds skinned meshes to cloned bones; Object3D.clone would
  // keep the original skeleton, posed by the original's world transform.
  const source = clone(object);
  source.matrix.identity();
  source.matrix.decompose(source.position, source.quaternion, source.scale);
  // Bones are descendants, so this also moves them; getVertexPosition reads bone.matrixWorld.
  source.updateMatrixWorld(true);

  const bounds = new Box3();
  forEachVertex(source, (p) => bounds.expandByPoint(p));
  if (bounds.isEmpty()) throw new Error("bakeImpostor: object has no visible geometry");
  const box: Impostor["box"] = [bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z];
  const centre = bounds.getCenter(new Vector3());
  const radius = boundingRadius(box);
  const directions: Vec3[] = [];
  for (let row = 0; row < frames; row++) for (let col = 0; col < frames; col++) directions.push(frameDirection(layout, frames, col, row));
  const halfSize = fittedHalfSize(source, centre, directions) * (1 + PAD);

  const distance = 2 * radius + 1e-3;
  const settings: BakeSettings = { uniforms: { impostorDistance: { value: distance }, impostorRadius: { value: radius } }, emissive: false };
  const { materials, emits } = swapMaterials(source, settings);
  settings.emissive = options.emissive ?? emits;
  const maps: ImpostorMap[] = settings.emissive ? [...MAPS] : ["base", "normalDepth", "orm"];

  const renderer = options.renderer ?? new WebGLRenderer({ antialias: false });
  const target = new WebGLRenderTarget(cell * supersample, cell * supersample, {
    count: maps.length,
    type: FloatType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: true,
  });
  const scene = new Scene();
  scene.add(source);
  const camera = new OrthographicCamera(-halfSize, halfSize, halfSize, -halfSize, 0, 4 * radius + 1e-3);
  camera.matrixAutoUpdate = false;
  // Bounds count meshes on every layer, so the bake draws them all.
  camera.layers.enableAll();

  const atlas = new Atlas(maps, frames, cell);
  const pixels = maps.map(() => new Float32Array(target.width * target.height * 4));
  try {
    if (!renderer.extensions.has("EXT_color_buffer_float"))
      throw new Error("bakeImpostor: this WebGL context cannot render to float targets (EXT_color_buffer_float)");
    for (const [index, n] of directions.entries()) {
      const { tangent: t, bitangent: b } = frameBasis(n);
      camera.matrix.set(
        t[0], b[0], n[0], centre.x + n[0] * distance,
        t[1], b[1], n[1], centre.y + n[1] * distance,
        t[2], b[2], n[2], centre.z + n[2] * distance,
        0, 0, 0, 1,
      );
      camera.updateMatrixWorld(true);
      const restore = borrow(renderer, target);
      try {
        renderer.clear(true, true, true);
        renderer.render(scene, camera);
        pixels.forEach((p, i) => renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, p, undefined, i));
      } finally {
        restore();
      }
      atlas.write(pixels, supersample, index % frames, Math.floor(index / frames));
      // Yield now and then so a long bake does not freeze the page.
      if (index % 16 === 15) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    target.dispose();
    for (const material of materials) material.dispose();
    if (!options.renderer) {
      renderer.dispose();
      // dispose() keeps the context alive; browsers cap live contexts at about 16.
      renderer.forceContextLoss();
    }
  }
  if (!atlas.covered()) throw new Error("bakeImpostor: nothing visible was baked");
  atlas.fillGutters();

  const impostor: Impostor = { version: 1, layout, frames, size: atlas.size, box, halfSize, maps, layers: atlas.layers };
  validateImpostor(impostor);
  return impostor;
}

/**
 * Point the renderer at `target`, without the app's XR camera or clipping planes, and
 * return a function that puts the app's state back. The bake holds a shared renderer
 * for one frame's render and read only: the app keeps rendering while the bake yields.
 */
function borrow(renderer: WebGLRenderer, target: WebGLRenderTarget): () => void {
  const previous = {
    target: renderer.getRenderTarget(),
    clear: renderer.getClearColor(new Color()),
    alpha: renderer.getClearAlpha(),
    autoClear: renderer.autoClear,
    xr: renderer.xr.enabled,
    planes: renderer.clippingPlanes,
    local: renderer.localClippingEnabled,
  };
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  renderer.xr.enabled = false;
  renderer.clippingPlanes = [];
  renderer.localClippingEnabled = false;
  return () => {
    renderer.setRenderTarget(previous.target);
    renderer.setClearColor(previous.clear, previous.alpha);
    renderer.autoClear = previous.autoClear;
    renderer.xr.enabled = previous.xr;
    renderer.clippingPlanes = previous.planes;
    renderer.localClippingEnabled = previous.local;
  };
}

/**
 * Call `visit` with the world position of every vertex the bake draws: meshes under
 * visible ancestors with a drawn material, every instance of an InstancedMesh, skinned
 * and morphed as rendered. Bounds and frame size both come from here, so they agree.
 * `visit` gets one reused vector.
 */
function forEachVertex(root: Object3D, visit: (p: Vector3) => void): void {
  const point = new Vector3();
  const matrix = new Matrix4();
  root.traverseVisible((mesh) => {
    if (!isMesh(mesh)) return;
    const drawn = [mesh.material].flat().some((m) => m.visible && m.colorWrite);
    if (!drawn) return;
    if (isBatchedMesh(mesh)) {
      // Its instance list is private; the corners of its instances' union box are close enough.
      mesh.computeBoundingBox();
      const bounds = mesh.boundingBox;
      if (!bounds || bounds.isEmpty()) return;
      const { min, max } = bounds;
      for (let i = 0; i < 8; i++) visit(point.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).applyMatrix4(mesh.matrixWorld));
      return;
    }
    const position = mesh.geometry.getAttribute("position");
    if (!position) return;
    const count = isInstancedMesh(mesh) ? mesh.count : 1;
    for (let k = 0; k < count; k++) {
      if (isInstancedMesh(mesh)) mesh.getMatrixAt(k, matrix).premultiply(mesh.matrixWorld);
      else matrix.copy(mesh.matrixWorld);
      // getVertexPosition applies morphs and, on a SkinnedMesh, the bones.
      for (let i = 0; i < position.count; i++) visit(mesh.getVertexPosition(i, point).applyMatrix4(matrix));
    }
  });
}

/**
 * The smallest square half-size that holds the object in every frame: the largest
 * extent of any vertex along any frame's image axes. Tighter than the bounding
 * sphere, which wastes about a third of every frame on a tree.
 */
function fittedHalfSize(source: Object3D, centre: Vector3, directions: Vec3[]): number {
  const axes = directions.flatMap((n) => {
    const { tangent, bitangent } = frameBasis(n);
    return [tangent, bitangent];
  });
  let half = 0;
  forEachVertex(source, (p) => {
    p.sub(centre);
    for (const a of axes) half = Math.max(half, Math.abs(p.x * a[0] + p.y * a[1] + p.z * a[2]));
  });
  if (half === 0) throw new Error("bakeImpostor: object has no extent (every vertex is at one point)");
  return half;
}

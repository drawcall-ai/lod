import {
  Box3,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  MeshDepthMaterial,
  MeshDistanceMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Ray,
  Sphere,
  Vector3,
  Vector4,
  type Camera,
  type Intersection,
  type Material,
  type Object3D,
  type Raycaster,
  type Scene,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from "three";
import { fadeUniforms, registerFade } from "../../fade.js";
import { TinyCaster } from "../../shadow.js";
import { acquireTextures, releaseTextures } from "./textures.js";
import { sameClass } from "../../three.js";
import { boundingRadius, boxCentre, boxExtent, validateImpostor, type Impostor, type ImpostorMap } from "../impostor.js";
import { applyEdits, type Edit } from "../../patch.js";
import { FRAGMENT, fragmentLit } from "./fragment.js";
import { VERTEX, vertexLit } from "./vertex.js";

export interface ImpostorMeshOptions {
  /** coverage below which a pixel is empty, in (0, 1); default 0.5 */
  alphaTest?: number;
  /** depth-parallax refinements per frame before blending (0 = off); default 2 */
  parallax?: number;
  /**
   * Depth disagreement (in depth-channel units, > 0) at which a frame's sample counts
   * half in the blend; smaller suppresses ghosting harder. Default 0.03.
   */
  tolerance?: number;
  /**
   * Mip bias for atlas reads. Negative keeps thin features crisp at a distance; the
   * dithered coverage absorbs the extra aliasing. Default -0.5.
   */
  mipBias?: number;
  /**
   * Write each pixel's baked surface depth instead of the card's in the main view, so
   * impostors intersect the ground and each other where the real object would. It
   * turns off early depth rejection, which makes large crowds of impostors several
   * times slower to draw. Default false. Shadow passes always use the surface depth.
   */
  pixelDepth?: boolean;
}

// ------------------------------------------------------------------ material patches

/** A GLSL float literal that keeps every digit, so a validated value stays valid. */
const float = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/** The options with defaults, validated, and the shader defines every pass shares. */
function settings(impostor: Impostor, options: ImpostorMeshOptions) {
  const { alphaTest = 0.5, parallax = 2, tolerance = 0.03, mipBias = -0.5 } = options;
  if (!(alphaTest > 0 && alphaTest < 1)) throw new Error(`ImpostorMesh: alphaTest must be in (0, 1), got ${alphaTest}`);
  if (!Number.isInteger(parallax) || parallax < 0) throw new Error(`ImpostorMesh: parallax must be an integer >= 0, got ${parallax}`);
  if (!(tolerance > 0)) throw new Error(`ImpostorMesh: tolerance must be > 0, got ${tolerance}`);
  if (!Number.isFinite(mipBias)) throw new Error(`ImpostorMesh: mipBias must be a number, got ${mipBias}`);
  const defines: Record<string, string> = {
    IMPOSTOR_CUTOFF: float(alphaTest),
    IMPOSTOR_TOLERANCE: float(tolerance),
    IMPOSTOR_MIP_BIAS: float(mipBias),
  };
  if (impostor.layout === "full") defines.IMPOSTOR_FULL = "";
  if (parallax > 0) defines.IMPOSTOR_PARALLAX = String(parallax);
  if (options.pixelDepth) defines.IMPOSTOR_PIXEL_DEPTH = "";
  if (impostor.maps.includes("emissive")) defines.IMPOSTOR_EMISSIVE = "";
  if (impostor.specular) defines.IMPOSTOR_SPECULAR = "";
  return { alphaTest, defines };
}

// three writes depth here and would overwrite the baked surface depth from <map_fragment>.
// (The distance material of point-light shadows has no such chunk and writes none.)
const PIXEL_DEPTH: Edit = ["fragment", "#include <logdepthbuf_fragment>", ""];

/** Make `material` draw the impostor card: the `edits` made when it compiles, on top of its own shader. */
function patch(material: Material, edits: () => Edit[], uniforms: object, defines: Record<string, string>): void {
  material.defines = { ...material.defines, ...defines };
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    applyEdits(shader, edits());
  };
  material.customProgramCacheKey = () => `impostor|${material.type}|${JSON.stringify(material.defines)}`;
}

// ------------------------------------------------------------------ mesh

/**
 * Draws an impostor once per instance: a standard InstancedMesh whose instance
 * matrices are ordinary model transforms of the source object (identity = where the
 * source was baked). Lighting, fog, shadows and instance colour all go through
 * three's MeshStandardMaterial; meshes of the same impostor share its textures.
 *
 * Like a Lod's meshes, it draws nothing into a directional light's shadow map whose texels
 * are wider than its largest instance.
 *
 * It uses `onBeforeRender`, `onBeforeShadow` and `onAfterShadow` itself: assign your own
 * only if it calls the method it replaces (`ImpostorMesh.prototype.onBeforeRender.call(this, ...)`).
 */
export class ImpostorMesh extends InstancedMesh<PlaneGeometry, MeshStandardMaterial> {
  readonly isImpostorMesh = true;
  readonly impostor: Impostor;
  /** Per-draw state the shaders read: multisampled target, viewing camera position. */
  private readonly drawState: { multisample: { value: number }; viewer: { value: Vector3 } };
  private readonly tiny = new TinyCaster();
  /** The largest instance scale, as of the instance matrices' `version` and `count`. */
  private readonly largest = { version: -1, count: -1, scale: 1 };
  private disposed = false;

  constructor(impostor: Impostor, count = 1, options: ImpostorMeshOptions = {}) {
    validateImpostor(impostor);
    const { alphaTest, defines } = settings(impostor, options);
    // Off unless a Lod drives it; every pass shares these.
    const fading = fadeUniforms();
    const textures = acquireTextures(impostor);
    const layer = (map: ImpostorMap) => textures[impostor.maps.indexOf(map)] ?? null;
    const drawState = { multisample: { value: 1 }, viewer: { value: new Vector3() } };
    const uniforms = {
      ...fading,
      impostorCentre: { value: new Vector3(...boxCentre(impostor.box)) },
      impostorRadius: { value: boundingRadius(impostor.box) },
      impostorExtent: { value: new Vector3(...boxExtent(impostor.box)) },
      impostorBase: { value: layer("base") },
      impostorNormalDepth: { value: layer("normalDepth") },
      impostorOrm: { value: layer("orm") },
      impostorEmissive: { value: layer("emissive") },
      impostorSpecular: { value: new Vector4(...(impostor.specular ?? [0, 0, 0, 0])) },
      impostorFrames: { value: impostor.frames },
      impostorSize: { value: impostor.size },
      impostorHalfSize: { value: impostor.halfSize },
      impostorMultisample: drawState.multisample,
      impostorViewer: drawState.viewer,
      impostorPlacement: { value: new Matrix4() },
    };

    const material = new MeshStandardMaterial({
      roughness: 1,
      metalness: 1,
      emissive: layer("emissive") ? 0xffffff : 0x000000,
      alphaTest,
      alphaToCoverage: true,
      side: DoubleSide, // the card may face either way after a mirrored instance matrix
    });
    material.name = "impostor";
    const lit = () => [...VERTEX, ...vertexLit(), ...FRAGMENT, ...fragmentLit(), ...(options.pixelDepth ? [PIXEL_DEPTH] : [])];
    patch(material, lit, uniforms, { ...defines, IMPOSTOR_LIT: "" });

    // The card is built in the shader; the geometry carries the source's bounds so
    // culling, computeBoundingSphere and raycasting see the real object.
    const geometry = new PlaneGeometry(1, 1);
    geometry.boundingBox = new Box3().setFromArray(impostor.box);
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());

    super(geometry, material, count);
    this.impostor = impostor;
    internals.set(this, { options, placement: uniforms.impostorPlacement.value, diameter: null });
    this.drawState = drawState;

    // Shadow passes: the same card, baked surface depth and coverage, facing the light.
    // No parallax walk there: shadow maps cover far more impostor pixels than the view,
    // and shadows are too soft to show it. Shadow maps sample the depth texture, so the
    // surface depth puts the resolved surface into them, not the card. They fade as
    // FADE_SHADOW_DISCARD says. three sets these materials' side and alphaTest itself.
    const { IMPOSTOR_PARALLAX: _, ...rest } = defines;
    const shadowDefines = { ...rest, IMPOSTOR_PIXEL_DEPTH: "", IMPOSTOR_SHADOW: "" };
    this.customDepthMaterial = new MeshDepthMaterial();
    patch(this.customDepthMaterial, () => [...VERTEX, ...FRAGMENT, PIXEL_DEPTH], uniforms, shadowDefines);
    this.customDistanceMaterial = new MeshDistanceMaterial();
    patch(this.customDistanceMaterial, () => [...VERTEX, ...FRAGMENT], uniforms, shadowDefines);
    for (const faded of [material, this.customDepthMaterial, this.customDistanceMaterial]) registerFade(faded, fading);
  }

  /**
   * Alpha-to-coverage only works on multisampled targets; tell the shader which this
   * is. three re-uploads material uniforms at the first draw after a material or
   * target switch, which includes the first draw of every render() call.
   */
  override onBeforeRender(renderer: WebGLRenderer, _scene: Scene, camera: Camera): void {
    const target = renderer.getRenderTarget();
    const multisampled = target ? target.samples > 0 : (renderer.getContext().getContextAttributes()?.antialias ?? false);
    this.drawState.multisample.value = Number(multisampled);
    this.trackCamera(camera);
  }

  /** Shadow passes fade by the viewing camera too (shadows render before the view). */
  override onBeforeShadow(renderer: WebGLRenderer, _object: Object3D, camera: Camera, shadowCamera: Camera): void {
    this.trackCamera(camera);
    this.tiny.skip(this, renderer, shadowCamera, this.casterDiameter());
  }

  override onAfterShadow(): void {
    this.tiny.restore(this);
  }

  /** The largest instance's diameter in world units. */
  private casterDiameter(): number {
    const { diameter } = internalsOf(this);
    if (diameter) return diameter();
    const { largest, instanceMatrix } = this;
    if (largest.version !== instanceMatrix.version || largest.count !== this.count) {
      largest.version = instanceMatrix.version;
      largest.count = this.count;
      largest.scale = 0;
      for (let i = 0; i < this.count; i++) largest.scale = Math.max(largest.scale, this.getMatrixAt(i, matrix).getMaxScaleOnAxis());
    }
    return 2 * boundingRadius(this.impostor.box) * largest.scale * this.matrixWorld.getMaxScaleOnAxis();
  }

  private trackCamera(camera: Camera): void {
    this.drawState.viewer.value.setFromMatrixPosition(camera.matrixWorld);
  }

  override copy(source: ImpostorMesh, recursive?: boolean): this {
    if (source.impostor !== this.impostor) throw new Error("ImpostorMesh.copy: the source draws a different impostor");
    // InstancedMesh.copy would adopt the source's material and geometry; keep our own.
    const { material, geometry } = this;
    super.copy(source, recursive);
    this.material = material;
    this.geometry = geometry;
    internalsOf(this).placement.copy(internalsOf(source).placement);
    return this;
  }

  override clone(recursive?: boolean): this {
    const clone = new ImpostorMesh(this.impostor, this.count, internalsOf(this).options).copy(this, recursive);
    // three's clone builds `new this.constructor()`; a subclass takes other arguments.
    if (!sameClass(this, clone)) throw new Error("ImpostorMesh.clone: a subclass must override clone");
    return clone;
  }

  /** Hits each instance's bounding box of the source object. */
  override raycast(raycaster: Raycaster, intersects: Intersection[]): void {
    box.setFromArray(this.impostor.box);
    const { placement } = internalsOf(this);
    for (let i = 0; i < this.count; i++) {
      this.getMatrixAt(i, matrix).multiply(placement).premultiply(this.matrixWorld);
      inverse.copy(matrix).invert();
      ray.copy(raycaster.ray).applyMatrix4(inverse);
      if (!ray.intersectBox(box, point)) continue;
      point.applyMatrix4(matrix);
      const distance = raycaster.ray.origin.distanceTo(point);
      if (distance < raycaster.near || distance > raycaster.far) continue;
      intersects.push({ distance, point: point.clone(), object: this, instanceId: i });
    }
  }

  override dispose(): this {
    if (this.disposed) return this;
    this.disposed = true;
    super.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.customDepthMaterial?.dispose();
    this.customDistanceMaterial?.dispose();
    releaseTextures(this.impostor);
    return this;
  }
}

// Scratch for raycasts.
const box = new Box3();
const matrix = new Matrix4();
const inverse = new Matrix4();
const ray = new Ray();
const point = new Vector3();

/** What InstancedLod needs and the public class does not show. */
interface Internals {
  options: ImpostorMeshOptions;
  placement: Matrix4;
  /** The largest instance's diameter in world units, when someone else measures it. */
  diameter: (() => number) | null;
}

const internals = new WeakMap<ImpostorMesh, Internals>();

function internalsOf(mesh: ImpostorMesh): Internals {
  const found = internals.get(mesh);
  if (!found) throw new Error("ImpostorMesh: not built by its constructor");
  return found;
}

/**
 * An ImpostorMesh like `template` for `count` instances, its card placed by `placement`
 * within each instance's space (instance matrix × placement), as InstancedLod draws it;
 * `diameter` measures its largest instance.
 */
export function impostorInstances(template: ImpostorMesh, count: number, placement: Matrix4, diameter: () => number): ImpostorMesh {
  const mesh = new ImpostorMesh(template.impostor, count, internalsOf(template).options);
  internalsOf(mesh).placement.copy(placement);
  internalsOf(mesh).diameter = diameter;
  // A tint set on the template, as for a level drawn by a Lod.
  mesh.material.color.copy(template.material.color);
  return mesh;
}

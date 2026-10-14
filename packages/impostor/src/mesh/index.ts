import {
  Box3,
  DataTexture,
  DoubleSide,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  MeshDepthMaterial,
  MeshDistanceMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  PlaneGeometry,
  Ray,
  RGBAFormat,
  Sphere,
  SRGBColorSpace,
  UnsignedByteType,
  Vector2,
  Vector3,
  type Camera,
  type Intersection,
  type Material,
  type Object3D,
  type Raycaster,
  type Scene,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from "three";
import { boundsUniforms, toFadeBand } from "../handoff.js";
import { validateImpostor, type Impostor, type ImpostorMap } from "../impostor.js";
import { applyEdits, type Edit } from "../patch.js";
import { CARD, CARD_LIT } from "./card.js";
import { SURFACE, SURFACE_LIT } from "./surface.js";

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
  lodBias?: number;
  /**
   * Write each pixel's baked surface depth instead of the card's in the main view, so
   * impostors intersect the ground and each other where the real object would. It
   * turns off early depth rejection: in a measured 40k-tree forest the frame went from
   * 5.7 to 20 ms. Default false. Shadow passes always use the surface depth.
   */
  pixelDepth?: boolean;
  /**
   * Hand-off band to the real object, as subtense (bounding diameter / distance): above
   * `fadeBand[1]` the impostor is gone, below `fadeBand[0]` it is fully drawn, and in
   * between it dithers against a real object patched with `fadeObject`. Default: none.
   */
  fadeBand?: [number, number];
}

// ------------------------------------------------------------------ textures

/** One set of GPU textures per impostor, shared by every mesh drawing it. */
const shared = new WeakMap<Impostor, { textures: DataTexture[]; users: number }>();

function acquireTextures(impostor: Impostor): DataTexture[] {
  let entry = shared.get(impostor);
  if (!entry) {
    const textures = impostor.layers.map((layer, i) => {
      const texture = new DataTexture(layer, impostor.size, impostor.size, RGBAFormat, UnsignedByteType);
      const map = impostor.maps[i];
      texture.colorSpace = map === "base" || map === "emissive" ? SRGBColorSpace : NoColorSpace;
      texture.generateMipmaps = true;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.magFilter = LinearFilter;
      texture.needsUpdate = true;
      return texture;
    });
    entry = { textures, users: 0 };
    shared.set(impostor, entry);
  }
  entry.users++;
  return entry.textures;
}

function releaseTextures(impostor: Impostor): void {
  const entry = shared.get(impostor);
  if (!entry || --entry.users > 0) return;
  for (const texture of entry.textures) texture.dispose();
  shared.delete(impostor);
}

// ------------------------------------------------------------------ material patches

/** A GLSL float literal that keeps every digit, so a validated value stays valid. */
const float = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/** The options with defaults, validated, and the shader defines every pass shares. */
function settings(impostor: Impostor, options: ImpostorMeshOptions) {
  const { alphaTest = 0.5, parallax = 2, tolerance = 0.03, lodBias = -0.5 } = options;
  if (!(alphaTest > 0 && alphaTest < 1)) throw new Error(`ImpostorMesh: alphaTest must be in (0, 1), got ${alphaTest}`);
  if (!Number.isInteger(parallax) || parallax < 0) throw new Error(`ImpostorMesh: parallax must be an integer >= 0, got ${parallax}`);
  if (!(tolerance > 0)) throw new Error(`ImpostorMesh: tolerance must be > 0, got ${tolerance}`);
  if (!Number.isFinite(lodBias)) throw new Error(`ImpostorMesh: lodBias must be a number, got ${lodBias}`);
  const defines: Record<string, string> = {
    IMPOSTOR_CUTOFF: float(alphaTest),
    IMPOSTOR_TOLERANCE: float(tolerance),
    IMPOSTOR_LOD_BIAS: float(lodBias),
  };
  if (impostor.layout === "full") defines.IMPOSTOR_FULL = "";
  if (parallax > 0) defines.IMPOSTOR_PARALLAX = String(parallax);
  if (options.pixelDepth) defines.IMPOSTOR_PIXEL_DEPTH = "";
  if (impostor.maps.includes("emissive")) defines.IMPOSTOR_EMISSIVE = "";
  return { alphaTest, defines };
}

// three writes depth here and would overwrite the baked surface depth from <map_fragment>.
// (The distance material of point-light shadows has no such chunk and writes none.)
const PIXEL_DEPTH: Edit = ["fragment", "#include <logdepthbuf_fragment>", ""];

/** Make `material` draw the impostor card: `edits` on top of its own shader. */
function patch(material: Material, edits: Edit[], uniforms: object, defines: Record<string, string>): void {
  material.defines = { ...material.defines, ...defines };
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    applyEdits(shader, edits);
  };
  material.customProgramCacheKey = () => `impostor|${material.type}|${JSON.stringify(material.defines)}`;
}

// ------------------------------------------------------------------ mesh

/**
 * Draws an impostor once per instance: a standard InstancedMesh whose instance
 * matrices are ordinary model transforms of the source object (identity = where the
 * source was baked). Lighting, fog, shadows and instance colour all go through
 * three's MeshStandardMaterial; meshes of the same impostor share its textures.
 */
export class ImpostorMesh extends InstancedMesh<PlaneGeometry, MeshStandardMaterial> {
  readonly isImpostorMesh = true;
  readonly impostor: Impostor;
  private readonly options: ImpostorMeshOptions;
  /**
   * The hand-off band (see `ImpostorMeshOptions.fadeBand`); (0, 0) is off. Give the same
   * Vector2 to `fadeObject`/`fadeMaterial` so changing it moves both sides together.
   * A clone gets its own copy.
   */
  readonly fadeBand: Vector2;
  /** Per-draw state the shaders read: multisampled target, viewing camera position, orthographic. */
  private readonly drawState: { multisample: { value: number }; viewer: { value: Vector3 }; ortho: { value: number } };
  private disposed = false;

  constructor(impostor: Impostor, count = 1, options: ImpostorMeshOptions = {}) {
    validateImpostor(impostor);
    const { alphaTest, defines } = settings(impostor, options);
    const fadeBand = options.fadeBand ? toFadeBand(options.fadeBand) : new Vector2(0, 0);
    const textures = acquireTextures(impostor);
    const layer = (map: ImpostorMap) => textures[impostor.maps.indexOf(map)] ?? null;
    const drawState = { multisample: { value: 1 }, viewer: { value: new Vector3() }, ortho: { value: 0 } };
    const uniforms = {
      ...boundsUniforms(impostor),
      impostorBase: { value: layer("base") },
      impostorNormalDepth: { value: layer("normalDepth") },
      impostorOrm: { value: layer("orm") },
      impostorEmissive: { value: layer("emissive") },
      impostorFrames: { value: impostor.frames },
      impostorSize: { value: impostor.size },
      impostorHalfSize: { value: impostor.halfSize },
      impostorFade: { value: fadeBand },
      impostorMultisample: drawState.multisample,
      impostorViewer: drawState.viewer,
      impostorViewerOrtho: drawState.ortho,
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
    const lit = [...CARD, ...CARD_LIT, ...SURFACE, ...SURFACE_LIT, ...(options.pixelDepth ? [PIXEL_DEPTH] : [])];
    patch(material, lit, uniforms, { ...defines, IMPOSTOR_LIT: "" });

    // The card is built in the shader; the geometry carries the source's bounds so
    // culling, computeBoundingSphere and raycasting see the real object.
    const geometry = new PlaneGeometry(1, 1);
    geometry.boundingBox = new Box3().setFromArray(impostor.box);
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());

    super(geometry, material, count);
    this.impostor = impostor;
    this.options = options;
    this.fadeBand = fadeBand;
    this.drawState = drawState;

    // Shadow passes: the same card, baked surface depth and coverage, facing the light.
    // No parallax walk there: it was most of the frame in a measured forest (shadow maps
    // cover far more impostor pixels than the view), and shadows are too soft to show it.
    // Shadow maps sample the depth texture, so the surface depth puts the resolved surface
    // into them, not the card. three sets these materials' side and alphaTest itself.
    const { IMPOSTOR_PARALLAX: _, ...rest } = defines;
    const shadowDefines = { ...rest, IMPOSTOR_PIXEL_DEPTH: "" };
    this.customDepthMaterial = new MeshDepthMaterial();
    patch(this.customDepthMaterial, [...CARD, ...SURFACE, PIXEL_DEPTH], uniforms, shadowDefines);
    this.customDistanceMaterial = new MeshDistanceMaterial();
    patch(this.customDistanceMaterial, [...CARD, ...SURFACE], uniforms, shadowDefines);
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

  /** Shadow passes hand off by the viewing camera too (shadows render before the view). */
  override onBeforeShadow(_renderer: WebGLRenderer, _object: Object3D, camera: Camera): void {
    this.trackCamera(camera);
  }

  private trackCamera(camera: Camera): void {
    this.drawState.viewer.value.setFromMatrixPosition(camera.matrixWorld);
    // Orthographic, as the shaders test it: no perspective divide.
    this.drawState.ortho.value = Number(camera.projectionMatrix.elements[15] === 1);
  }

  override copy(source: ImpostorMesh, recursive?: boolean): this {
    if (source.impostor !== this.impostor) throw new Error("ImpostorMesh.copy: the source draws a different impostor");
    // InstancedMesh.copy would adopt the source's material and geometry; keep our own.
    const { material, geometry } = this;
    super.copy(source, recursive);
    this.material = material;
    this.geometry = geometry;
    this.fadeBand.copy(source.fadeBand);
    return this;
  }

  override clone(recursive?: boolean): this {
    // As three's own clone: typed `this`, built as an ImpostorMesh. A subclass with other
    // constructor arguments overrides it.
    return new ImpostorMesh(this.impostor, this.count, this.options).copy(this, recursive) as this;
  }

  /** Hits each instance's bounding box of the source object. */
  override raycast(raycaster: Raycaster, intersects: Intersection[]): void {
    const box = new Box3().setFromArray(this.impostor.box);
    const matrix = new Matrix4();
    const inverse = new Matrix4();
    const ray = new Ray();
    const point = new Vector3();
    for (let i = 0; i < this.count; i++) {
      this.getMatrixAt(i, matrix);
      matrix.premultiply(this.matrixWorld);
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

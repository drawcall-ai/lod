import {
  Box3,
  Color,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Ray,
  Sphere,
  StorageInstancedBufferAttribute,
  Vector3,
  type Intersection,
  type Raycaster,
} from "three/webgpu";
import { setDraw } from "../../fade.js";
import { sameClass } from "../../three.js";
import { copyWind } from "../../wind/index.js";
import { boundingRadius, validateImpostor, type Impostor } from "../impostor.js";
import { ImpostorMaterial } from "./material.js";

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
}

/** The options with defaults, validated. */
function shadingOf(options: ImpostorMeshOptions) {
  const { alphaTest = 0.5, parallax = 2, tolerance = 0.03, mipBias = -0.5 } = options;
  if (!(alphaTest > 0 && alphaTest < 1)) throw new Error(`ImpostorMesh: alphaTest must be in (0, 1), got ${alphaTest}`);
  if (!Number.isInteger(parallax) || parallax < 0) throw new Error(`ImpostorMesh: parallax must be an integer >= 0, got ${parallax}`);
  if (!(tolerance > 0)) throw new Error(`ImpostorMesh: tolerance must be > 0, got ${tolerance}`);
  if (!Number.isFinite(mipBias)) throw new Error(`ImpostorMesh: mipBias must be a number, got ${mipBias}`);
  return { cutoff: alphaTest, parallax, tolerance, mipBias };
}

const scratch = new Matrix4();
const box = new Box3();
const sphere = new Sphere();

/**
 * Draws an impostor once per instance, as an InstancedMesh draws a mesh: instance
 * matrices are ordinary model transforms of the source object (identity = where the
 * source was baked), set with `setMatrixAt`, and instance colours with `setColorAt`.
 * Lighting, fog, shadows and colour go through three's MeshStandardNodeMaterial; meshes
 * of the same impostor share its textures, and a clone shares its material: clones of
 * one instance draw with one shader.
 *
 * It draws nothing of an instance into a directional light's shadow map whose texels are
 * wider than the instance. Like an InstancedMesh, it is culled by `boundingSphere`,
 * which `computeBoundingSphere` makes from the instances.
 * On multisampled targets, edges use alpha-to-coverage and leave fractional canvas
 * alpha; use a renderer with `alpha: false` when the page must not show through them.
 */
export class ImpostorMesh extends Mesh<PlaneGeometry, ImpostorMaterial> {
  readonly isImpostorMesh = true;
  readonly impostor: Impostor;
  /** The options it draws with. */
  options: ImpostorMeshOptions;
  /** Instances drawn. */
  count: number;
  /** 16 floats per instance, read from its storage buffer for every draw. */
  instanceMatrix: StorageInstancedBufferAttribute;
  /** RGB (and a pad) per instance, once `setColorAt` was called. */
  instanceColor: StorageInstancedBufferAttribute | null = null;
  boundingSphere: Sphere | null = null;
  /** Where the card sits within an instance's space (InstancedLod places it). */
  readonly placement = new Matrix4();
  private disposed = false;

  constructor(impostor: Impostor, count = 1, options: ImpostorMeshOptions = {}, material?: ImpostorMaterial) {
    validateImpostor(impostor);
    if (material && material.impostor !== impostor) throw new Error("ImpostorMesh: the material draws another impostor");
    // The card is built in the shader; the geometry carries the source's bounds so
    // culling and raycasting see the real object.
    const geometry = new PlaneGeometry(1, 1);
    geometry.boundingBox = new Box3().setFromArray(impostor.box);
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
    super(geometry, (material ?? new ImpostorMaterial(impostor, shadingOf(options))).acquire());
    this.impostor = impostor;
    this.options = options;
    this.count = count;
    this.instanceMatrix = new StorageInstancedBufferAttribute(count, 16);
    for (let i = 0; i < count; i++) scratch.identity().toArray(this.instanceMatrix.array, i * 16);
    setDraw(this, { kind: "instances", fades: null, radius: boundingRadius(impostor.box), tint: new Color(1, 1, 1) });
  }

  setMatrixAt(index: number, matrix: Matrix4): void {
    matrix.toArray(this.instanceMatrix.array, index * 16);
    this.instanceMatrix.needsUpdate = true;
  }

  getMatrixAt(index: number, matrix: Matrix4): Matrix4 {
    return matrix.fromArray(this.instanceMatrix.array, index * 16);
  }

  setColorAt(index: number, color: Color): void {
    if (!this.instanceColor) {
      this.instanceColor = new StorageInstancedBufferAttribute(new Float32Array(this.count * 4).fill(1), 4);
    }
    color.toArray(this.instanceColor.array, index * 4);
    this.instanceColor.needsUpdate = true;
  }

  getColorAt(index: number, color: Color): Color {
    return this.instanceColor ? color.fromArray(this.instanceColor.array, index * 4) : color.setRGB(1, 1, 1);
  }

  /** Bound every instance's bounding box of the source object. */
  computeBoundingSphere(): void {
    this.boundingSphere ??= new Sphere();
    this.boundingSphere.makeEmpty();
    const own = box.setFromArray(this.impostor.box).getBoundingSphere(sphere);
    for (let i = 0; i < this.count; i++) this.boundingSphere.union(own.clone().applyMatrix4(this.getMatrixAt(i, scratch)));
  }

  override copy(source: ImpostorMesh, recursive?: boolean): this {
    if (source.impostor !== this.impostor) throw new Error("ImpostorMesh.copy: the source draws a different impostor");
    if (source === this) return this;
    // Mesh.copy adopts the source's material and geometry; each card owns its geometry.
    const { geometry, material } = this;
    super.copy(source, recursive);
    this.geometry = geometry;
    if (material !== this.material) {
      material.release();
      this.material.acquire();
    }
    this.count = source.count;
    this.options = source.options;
    this.placement.copy(source.placement);
    this.instanceMatrix.dispose();
    this.instanceColor?.dispose();
    this.instanceMatrix = new StorageInstancedBufferAttribute(source.instanceMatrix.array.slice(), 16);
    this.instanceColor = source.instanceColor ? new StorageInstancedBufferAttribute(source.instanceColor.array.slice(), 4) : null;
    this.boundingSphere = source.boundingSphere?.clone() ?? null;
    copyWind(source, this);
    return this;
  }

  override clone(recursive?: boolean): this {
    const clone = new ImpostorMesh(this.impostor, this.count, this.options, this.material).copy(this, recursive);
    // three's clone builds `new this.constructor()`; a subclass takes other arguments.
    if (!sameClass(this, clone)) throw new Error("ImpostorMesh.clone: a subclass must override clone");
    return clone;
  }

  /** Hits each instance's bounding box of the source object. */
  override raycast(raycaster: Raycaster, intersects: Intersection[]): void {
    box.setFromArray(this.impostor.box);
    for (let i = 0; i < this.count; i++) {
      this.getMatrixAt(i, matrix).multiply(this.placement).premultiply(this.matrixWorld);
      inverse.copy(matrix).invert();
      ray.copy(raycaster.ray).applyMatrix4(inverse);
      if (!ray.intersectBox(box, point)) continue;
      point.applyMatrix4(matrix);
      const distance = raycaster.ray.origin.distanceTo(point);
      if (distance < raycaster.near || distance > raycaster.far) continue;
      intersects.push({ distance, point: point.clone(), object: this, instanceId: i });
    }
  }

  /** Frees its geometry and instance buffers; the last mesh sharing its material frees that too. */
  dispose(): this {
    if (this.disposed) return this;
    this.disposed = true;
    this.geometry.dispose();
    this.instanceMatrix.dispose();
    this.instanceColor?.dispose();
    this.material.release();
    return this;
  }
}

// Scratch for raycasts.
const matrix = new Matrix4();
const inverse = new Matrix4();
const ray = new Ray();
const point = new Vector3();

/**
 * An ImpostorMesh like `template` for `count` instances, its card placed by `placement`
 * within each instance's space (instance matrix × placement), as InstancedLod draws it.
 * Materials and runtime shading are shared; placement is per draw.
 */
export function impostorInstances(template: ImpostorMesh, count: number, placement: Matrix4): ImpostorMesh {
  const mesh = new ImpostorMesh(template.impostor, count, template.options, template.material);
  mesh.placement.copy(placement);
  // A tint and mip bias set on the template, as for a level drawn by a Lod.
  mesh.material.color.copy(template.material.color);
  mesh.material.mipBias.value = template.material.mipBias.value;
  return mesh;
}

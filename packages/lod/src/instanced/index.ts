import {
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Object3D,
  Ray,
  Sphere,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Intersection,
  type Mesh,
  type Raycaster,
} from "three";
import { measureLevels } from "../bounds.js";
import { disposeMaterials, disposeTree } from "../dispose.js";
import { fadeMesh, writeFades } from "../fade.js";
import { placeInterior } from "../baked/interior/material.js";
import { impostorInstances } from "../impostor/mesh/index.js";
import { Level, cloneLevels, copyThresholds, estimate, validate, type InstancedLodLevel } from "../levels.js";
import { Lod } from "../lod.js";
import { skipTinyShadows } from "../shadow.js";
import { isImpostorMesh, isInstancedMesh, isLOD, isMesh, rejectSkinned, sameClass } from "../three.js";
import { View, Viewports } from "../view.js";
import { Sorter } from "./sort.js";

const IDENTITY = new Matrix4();
const view = new View();
const inverse = new Matrix4();
const eye = new Vector3();
const ray = new Ray();
const sphere = new Sphere();
const instance = new Matrix4();
const world = new Matrix4();
const hits: Intersection[] = [];

/** A mesh of the source level, as a raycast meets it: the template and where it sits in an instance. */
interface Probe {
  mesh: Mesh;
  placement: Matrix4;
}

/**
 * `count` copies of one object with levels of detail, each switched by its own height on
 * screen: `Lod` for instances. Each level is one instance-matrix buffer that all its
 * meshes share, holding the instances that show the level; an instance near a switch is
 * in both neighbours and they split its pixels with the dither. Thresholds,
 * `forceLevel`, `Lod.quality`, `Lod.debug` and shadows work as for `Lod`; each level
 * also counts the instances that drew it, and is culled by their bounds. A level draws
 * nothing into a directional light's shadow map whose texels are wider than its largest
 * instance.
 *
 * Instance matrices are model transforms of the object, as for an InstancedMesh; set
 * them with `setMatrixAt`, and instance colours with `setColorAt`. `update` sorts the
 * instances again when the camera, a matrix or a setting changed, and writes only the
 * instances that changed level. Its own transform (and its parents') should scale
 * uniformly; instances may scale any way.
 *
 * Levels are templates, read when it is built: their meshes are drawn instanced, not
 * added to the scene. They cannot contain skinned meshes, InstancedMeshes (other than an
 * ImpostorMesh) or nested Lods. To build a hierarchy on top, leave level 0 empty (see
 * `Lod`) and draw the detail of the instances `levelOf` reports at level 0 yourself.
 */
export class InstancedLod extends Object3D {
  readonly isLOD = true;
  readonly isInstancedLod = true;
  /** Let the renderer call `update` with its camera every frame. */
  autoUpdate = true;
  /** Draw only this level for every instance, without fades. */
  forceLevel: number | null = null;
  readonly levels: readonly InstancedLodLevel[];
  readonly count: number;

  private readonly entries: Level[] = [];
  /** Per level, the instanced meshes drawing it. */
  private readonly meshes: InstancedMesh[][] = [];
  private readonly probes: Probe[] = [];
  private readonly matrices: Float32Array;
  /** Instance colours, 3 floats each, once `setColorAt` was called. */
  private colors: Float32Array | null = null;
  private sorter: Sorter | null = null;
  /** Bounding sphere of the source in an instance's space. */
  private sphere = new Sphere();
  private readonly viewports = new Viewports();
  /** What the last sort saw, to skip the next one when nothing changed. */
  private readonly seen = {
    camera: new Matrix4(),
    projection: new Matrix4(),
    world: new Matrix4(),
    height: 0,
    quality: 0,
    forceLevel: -1,
    maxPixels: new Float64Array(0),
  };

  /** `levels[0]` is the source. Empty only as the target of `copy`. */
  constructor(levels: Object3D[] = [], count = 0) {
    super();
    if (!Number.isInteger(count) || count < 0) throw new Error(`InstancedLod: count must be an integer >= 0, got ${count}`);
    this.levels = this.entries;
    this.count = count;
    this.matrices = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) IDENTITY.toArray(this.matrices, i * 16);
    if (levels.length > 0) this.build(levels);
  }

  private build(objects: Object3D[]): void {
    const [source] = objects;
    if (!source) throw new Error("InstancedLod: needs at least the source level");
    for (const object of objects) {
      rejectSkinned(object, "InstancedLod");
      object.traverse((node) => {
        if (isLOD(node)) throw new Error("InstancedLod: levels cannot contain a Lod or InstancedLod; nest them with Lod");
        if (isInstancedMesh(node) && !isImpostorMesh(node)) throw new Error(`InstancedLod: levels cannot contain an InstancedMesh ("${node.name}")`);
      });
    }
    const { own, placed } = measureLevels(objects, "InstancedLod");
    this.sphere = placed;
    // Per level, the instance matrices all its meshes share.
    const buffers = objects.map((object) => ({
      object,
      attribute: new InstancedBufferAttribute(new Float32Array(this.count * 16), 16).setUsage(DynamicDrawUsage),
    }));
    const sorter = new Sorter(
      this.count,
      this.matrices,
      this.sphere,
      buffers.map((b) => b.attribute),
    );
    this.sorter = sorter;
    buffers.forEach(({ object, attribute }, i) => {
      const level = new Level(object, i, false, this.entries);
      this.entries.push(level);
      const meshes: InstancedMesh[] = [];
      // A template's own transform places it in the instance's space, as a Lod's child.
      object.updateWorldMatrix(true, true);
      const outside = object.parent ? object.parent.matrixWorld.clone().invert() : new Matrix4();
      object.traverse((node) => {
        if (!isMesh(node)) return;
        const placement = outside.clone().multiply(node.matrixWorld);
        meshes.push(this.instance(level, node, placement, attribute, sorter));
        if (i === 0) this.probes.push({ mesh: node, placement });
      });
      this.meshes.push(meshes);
    });
    this.colorLevels();
    this.seen.maxPixels = new Float64Array(this.entries.length);
    estimate(this.entries, 2 * own.radius);
    validate(this.entries);
  }

  /**
   * `template` drawn for every instance of `level`, from the level's instance matrices,
   * culled by the bounds of those instances.
   */
  private instance(level: Level, template: Mesh, placement: Matrix4, attribute: InstancedBufferAttribute, sorter: Sorter): InstancedMesh {
    const { index } = level;
    // Out of shadow maps whose texels are wider than the level's largest instance.
    const diameter = () => 2 * sorter.radius(index) * this.matrixWorld.getMaxScaleOnAxis();
    // An impostor card is placed in the shader; any other mesh draws a copy of its
    // geometry moved into the instance's space, so the instance matrix is all it needs.
    const mesh = isImpostorMesh(template)
      ? impostorInstances(template, this.count, placement, diameter)
      : new InstancedMesh(placed(template.geometry, placement), template.material, this.count);
    if (!isImpostorMesh(mesh)) skipTinyShadows(mesh, diameter);
    fadeMesh(mesh, level, this.sphere, isImpostorMesh(template) ? placement : IDENTITY);
    if (!isImpostorMesh(template)) for (const material of [mesh.material].flat()) placeInterior(material, placement);
    mesh.instanceMatrix = attribute;
    mesh.name = template.name;
    mesh.castShadow = template.castShadow;
    mesh.receiveShadow = template.receiveShadow;
    mesh.count = 0;
    mesh.boundingSphere = sorter.bounds(index);
    this.viewports.watch(mesh);
    this.add(mesh);
    return mesh;
  }

  setMatrixAt(index: number, matrix: Matrix4): void {
    this.check(index);
    matrix.toArray(this.matrices, index * 16);
    this.sorter?.touch(index);
  }

  getMatrixAt(index: number, matrix: Matrix4): Matrix4 {
    this.check(index);
    return matrix.fromArray(this.matrices, index * 16);
  }

  /** Tint instance `index` by `color`, as InstancedMesh.setColorAt does, in every level. */
  setColorAt(index: number, color: Color): void {
    this.check(index);
    if (!this.colors) {
      this.colors = new Float32Array(this.count * 3).fill(1);
      this.colorLevels();
    }
    color.toArray(this.colors, index * 3);
    this.sorter?.touch(index);
  }

  /** Instance `index`'s colour: white unless set. */
  getColorAt(index: number, color: Color): Color {
    this.check(index);
    return this.colors ? color.fromArray(this.colors, index * 3) : color.setRGB(1, 1, 1);
  }

  /**
   * The finest level instance `index` drew in the last update, or null before the first.
   * Inside a fade the next coarser level draws too.
   */
  levelOf(index: number): number | null {
    this.check(index);
    return this.sorter?.finest(index) ?? null;
  }

  /** Give every level's meshes an instance-colour attribute the sorter fills, once there are colours. */
  private colorLevels(): void {
    const { colors, sorter } = this;
    if (!colors || !sorter) return;
    const attributes = this.meshes.map((meshes) => {
      const attribute = new InstancedBufferAttribute(new Float32Array(this.count * 3).fill(1), 3).setUsage(DynamicDrawUsage);
      for (const mesh of meshes) mesh.instanceColor = attribute;
      return attribute;
    });
    sorter.useColors(colors, attributes);
  }

  private check(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) throw new Error(`InstancedLod: index ${index} is not in 0..${this.count - 1}`);
  }

  /** Sort the instances into levels for `camera`; three's renderer calls this itself while `autoUpdate`. */
  update(camera: Camera): void {
    const { entries, sorter } = this;
    if (!sorter) return;
    validate(entries);
    const height = this.viewports.heightOf(camera);
    view.begin(camera, height, this.forceLevel);
    writeFades(entries, view, Lod.quality, Lod.debug);
    if (!this.changed(camera, height)) return;
    const q = view.scale * Lod.quality;
    if (this.forceLevel !== null && !entries[this.forceLevel]) throw new Error(`Lod: forceLevel ${this.forceLevel} is not a level`);
    if (this.forceLevel !== null) sorter.sortForced(this.forceLevel);
    else if (view.ortho) sorter.sortOrtho(entries, q * this.matrixWorld.getMaxScaleOnAxis());
    else sorter.sort(entries, eye.copy(view.eye).applyMatrix4(inverse.copy(this.matrixWorld).invert()), q, view.fades);
    for (const level of entries) {
      level.count = sorter.length(level.index);
      for (const mesh of this.meshes[level.index] ?? []) {
        mesh.count = level.count;
        mesh.visible = level.count > 0;
      }
    }
  }

  /** Whether anything the sort depends on changed since the last one; remembers it. */
  private changed(camera: Camera, height: number): boolean {
    const { seen, entries } = this;
    let changed = this.sorter?.changed === true || seen.height !== height || seen.quality !== Lod.quality || seen.forceLevel !== (this.forceLevel ?? -1);
    changed ||= !seen.camera.equals(camera.matrixWorld) || !seen.projection.equals(camera.projectionMatrix) || !seen.world.equals(this.matrixWorld);
    for (const level of entries) changed ||= seen.maxPixels[level.index] !== level.maxPixels;
    if (!changed) return false;
    seen.camera.copy(camera.matrixWorld);
    seen.projection.copy(camera.projectionMatrix);
    seen.world.copy(this.matrixWorld);
    seen.height = height;
    seen.quality = Lod.quality;
    seen.forceLevel = this.forceLevel ?? -1;
    for (const level of entries) seen.maxPixels[level.index] = level.maxPixels;
    return true;
  }

  /**
   * Hits every instance's source level, with `instanceId` set; `object` is this
   * InstancedLod. Meshes of the source on layers the raycaster does not test are skipped.
   */
  override raycast(raycaster: Raycaster, intersects: Intersection[]): boolean {
    ray.copy(raycaster.ray).applyMatrix4(inverse.copy(this.matrixWorld).invert());
    for (let i = 0; i < this.count; i++) {
      instance.fromArray(this.matrices, i * 16);
      if (!ray.intersectsSphere(sphere.copy(this.sphere).applyMatrix4(instance))) continue;
      for (const { mesh, placement } of this.probes) {
        if (!mesh.layers.test(raycaster.layers)) continue;
        // The template's own raycast, as if it stood where this instance does.
        const own = mesh.matrixWorld;
        mesh.matrixWorld = world.multiplyMatrices(this.matrixWorld, instance).multiply(placement);
        hits.length = 0;
        mesh.raycast(raycaster, hits);
        mesh.matrixWorld = own;
        for (const hit of hits) intersects.push(Object.assign(hit, { object: this, instanceId: i }));
      }
    }
    return false;
  }

  /**
   * Copies `source`'s levels, instances and settings into this empty InstancedLod of the
   * same count (it throws otherwise); the copy shares geometry and textures with `source`.
   */
  override copy(source: InstancedLod): this {
    if (this.entries.length > 0 || this.count !== source.count) throw new Error("InstancedLod.copy: copy into an empty InstancedLod of the same count");
    super.copy(source, false);
    this.matrices.set(source.matrices);
    this.colors = source.colors?.slice() ?? null;
    if (source.entries.length > 0) this.build(cloneLevels(source.entries));
    copyThresholds(source.entries, this.entries);
    this.forceLevel = source.forceLevel;
    this.autoUpdate = source.autoUpdate;
    return this;
  }

  override clone(): this {
    // three's clone builds `new this.constructor()`, which has no count.
    const clone = new InstancedLod([], this.count).copy(this);
    if (!sameClass(this, clone)) throw new Error("InstancedLod.clone: a subclass must override clone");
    return clone;
  }

  /**
   * Frees every level, the source included, and the instanced meshes. Clones share
   * geometry and textures, so dispose only once no clone draws any more.
   */
  dispose(): void {
    for (const mesh of this.meshes.flat()) {
      mesh.dispose();
      if (isImpostorMesh(mesh)) continue;
      mesh.geometry.dispose();
      disposeMaterials(mesh);
    }
    for (const { object } of this.entries) disposeTree(object);
  }
}

/** Placed copies of geometries, shared by every InstancedLod drawing the same mesh the same way. */
const copies = new WeakMap<BufferGeometry, Array<{ placement: Matrix4; geometry: BufferGeometry }>>();

/** `geometry` moved by `placement`: itself for the identity, else a copy made once. */
function placed(geometry: BufferGeometry, placement: Matrix4): BufferGeometry {
  if (placement.equals(IDENTITY)) return geometry;
  const known = copies.get(geometry) ?? [];
  copies.set(geometry, known);
  const hit = known.find((entry) => entry.placement.equals(placement));
  if (hit) return hit.geometry;
  const copy = geometry.clone().applyMatrix4(placement);
  known.push({ placement: placement.clone(), geometry: copy });
  return copy;
}

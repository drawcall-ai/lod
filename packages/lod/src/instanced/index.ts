import {
  InstancedMesh,
  type BufferAttribute,
  type Color,
  Matrix4,
  Object3D,
  Ray,
  Sphere,
  Vector3,
  type Camera,
  type Intersection,
  type Mesh,
  type Raycaster,
} from "three/webgpu";
import { measureLevels } from "../bounds.js";
import { disposeTree } from "../dispose.js";
import { drawOf, setDraw } from "../fade.js";
import { placeInterior } from "../baked/interior/material.js";
import { impostorInstances, type ImpostorMesh } from "../impostor/mesh/index.js";
import { FADE, Level, cloneLevels, copyThresholds, estimate, fadeProgress, levelAt, tintLevels, validate, type LodLevel } from "../levels.js";
import { Lod } from "../lod.js";
import { gpuRenderer, inShadowPass, isImpostorMesh, isInstancedMesh, isLOD, isMesh, rejectSkinned, sameClass } from "../three.js";
import { TYPICAL_HEIGHT, View, viewportHeight, watchViewport } from "../view.js";
import { WIND_BOUNDS } from "../wind/hooks.js";
import { copyWind } from "../wind/index.js";
import { groupMaterial, indirect, placed, ranges } from "./meshes.js";
import { ARGS_BYTES, Selection, type IndirectDraw } from "./select.js";

const IDENTITY = new Matrix4();
const view = new View();
const inverse = new Matrix4();
const ray = new Ray();
const sphere = new Sphere();
const instance = new Matrix4();
const world = new Matrix4();
const centre = new Vector3();
const hits: Intersection[] = [];

/**
 * Selections due before the next draw of any InstancedLod: the first level mesh to draw
 * runs them all in one compute call (each call has a cost of its own: an encoder, a
 * pass, a submit). Each renderer runs those its own buffers are not current with.
 */
const pending = new Set<Selection>();

/** A mesh drawing one level's slots: instanced, or an impostor's cards. */
type LevelMesh = InstancedMesh | ImpostorMesh;

/** A mesh of the source level, as a raycast meets it: the template and where it sits in an instance. */
interface Probe {
  mesh: Mesh;
  placement: Matrix4;
}

/** The last view `update` selected for, in the InstancedLod's space, for `levelOf`. */
interface Selected {
  /** Whether there was one. */
  selected: boolean;
  eye: Vector3;
  /** as `Selection.scale` */
  scale: number;
  ortho: boolean;
  fades: boolean;
  forced: number | null;
}

/**
 * `count` copies of one object with levels of detail, each switched by its own height on
 * screen: `Lod` for instances. The GPU sorts the instances into levels once per view
 * (see select.ts) and every mesh of a level draws the instances it holds in one indirect
 * draw; an instance near a switch is in both neighbours and they split its pixels with
 * the dither. Thresholds, `forceLevel`, `Lod.quality`, `Lod.debug` and shadows work as
 * for `Lod`; nothing of an instance is drawn into a directional light's shadow map whose
 * texels are wider than it. Each level is culled by the crowd's bounds, tightened for
 * finer levels to the region near the camera where their instances can draw.
 *
 * Instance matrices are model transforms of the object, as for an InstancedMesh; set
 * them with `setMatrixAt`, and instance colours with `setColorAt`. An instance at scale 0
 * draws nothing. Its own transform (and its parents') should scale uniformly; instances
 * may scale any way.
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
  readonly levels: readonly LodLevel[];
  readonly count: number;

  private readonly entries: Level[] = [];
  /** Per level, the meshes drawing it. */
  private readonly meshes: LevelMesh[][] = [];
  private readonly probes: Probe[] = [];
  private selection: Selection | null = null;
  /** Instance matrices, 16 floats each: the selection uploads them from here. */
  private readonly matrices: Float32Array;
  /** Instance colours, 4 floats each, once `setColorAt` was called. */
  private colors: Float32Array | null = null;
  /** Each instance's bounding sphere, centre and radius, in the InstancedLod's space. */
  private readonly spheres: Float32Array;
  /** Bounding sphere of the source in an instance's space. */
  private sphere = new Sphere();
  /** Around every instance; finer levels may use tighter bounds (see `reach`). */
  readonly bounds = new Sphere();
  /** Per level, what its meshes are culled by: `bounds`, or less where its instances must be near the camera. */
  private readonly reaches: Sphere[] = [];
  /** Culling padding for sway, as a share of each instance's radius. */
  private padding = 0;
  /** Instances `low..high` changed since they were last measured and uploaded; none when low > high. */
  private low = 0;
  private high = -1;
  /** The smallest and largest instance radius, of instances at a scale above 0. */
  private smallest = 0;
  private largest = 0;
  private readonly last: Selected = { selected: false, eye: new Vector3(), scale: 0, ortho: false, fades: false, forced: null };

  /** `levels[0]` is the source. Empty only as the target of `copy`. */
  constructor(levels: Object3D[] = [], count = 0) {
    super();
    if (!Number.isInteger(count) || count < 0) throw new Error(`InstancedLod: count must be an integer >= 0, got ${count}`);
    this.levels = this.entries;
    this.count = count;
    this.matrices = new Float32Array(count * 16);
    this.spheres = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) IDENTITY.toArray(this.matrices, i * 16);
    this.high = count - 1;
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
    // Every template mesh, split per material group: an indirect draw has one range.
    const parts = objects.map((object, level) => {
      // A template's own transform places it in the instance's space, as a Lod's child.
      object.updateWorldMatrix(true, true);
      const outside = object.parent ? object.parent.matrixWorld.clone().invert() : new Matrix4();
      const found: Array<{ template: Mesh; placement: Matrix4; group: number; draw: IndirectDraw }> = [];
      object.traverse((node) => {
        if (!isMesh(node)) return;
        const placement = outside.clone().multiply(node.matrixWorld);
        if (level === 0) this.probes.push({ mesh: node, placement });
        ranges(node).forEach((range, group) => found.push({ template: node, placement, group, draw: { level, ...range } }));
      });
      return found;
    });
    const draws = parts.flat().map((part) => part.draw);
    const selection = new Selection(
      this.matrices,
      this.sphere,
      parts.map((found) => found.length > 0),
      draws,
    );
    this.selection = selection;
    if (this.colors) this.useColors(selection, this.colors);
    let k = 0;
    parts.forEach((found, i) => {
      const level = new Level(at(objects, i), i, false, this.entries);
      this.entries.push(level);
      this.meshes.push(found.map((part) => this.instance(level, part.template, part.placement, part.group, k++ * ARGS_BYTES, selection)));
    });
    estimate(this.entries, 2 * own.radius);
    validate(this.entries);
  }

  /** Material group `group` of `template` drawn for every instance in `level`'s slots, from indirect draw arguments at byte `offset`. */
  private instance(level: Level, template: Mesh, placement: Matrix4, group: number, offset: number, selection: Selection): LevelMesh {
    const { slots } = selection;
    // An impostor card is placed in the shader; any other mesh draws its geometry moved
    // into the instance's space, so the instance matrix is all it needs.
    const mesh: LevelMesh = isImpostorMesh(template)
      ? impostorInstances(template, this.count, placement)
      : new InstancedMesh(placed(template.geometry, placement), groupMaterial(template, group), this.count);
    mesh.geometry = indirect(mesh.geometry, selection, offset);
    mesh.instanceMatrix = slots.matrices;
    mesh.instanceColor = slots.colors;
    setDraw(mesh, { kind: "instances", fades: slots.fades, radius: this.drawRadius, tint: level.tint });
    if (!isImpostorMesh(template)) placeInterior(mesh, placement);
    mesh.name = template.name;
    mesh.castShadow = template.castShadow;
    mesh.receiveShadow = template.receiveShadow;
    this.reaches[level.index] ??= this.bounds.clone();
    mesh.boundingSphere = this.reaches[level.index] ?? null;
    const previous = mesh.onBeforeRender;
    // Selected once per view, before the first level mesh draws: in the view, or in a
    // shadow pass that comes first. The GPU runs it before anything drawn after it.
    mesh.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
      previous.call(mesh, renderer, scene, camera, geometry, material, group);
      if (pending.size === 0) return;
      const gpu = gpuRenderer(renderer);
      // Each level's draws start at its slots (see select.ts).
      if (!gpu.hasFeature("indirect-first-instance")) throw new Error("InstancedLod: needs the GPU feature indirect-first-instance, which this device lacks");
      const passes = [...pending].flatMap((due) => due.take(gpu));
      pending.clear();
      if (passes.length > 0) gpu.compute(passes);
    };
    watchViewport(mesh);
    this.add(mesh);
    return mesh;
  }

  setMatrixAt(index: number, matrix: Matrix4): void {
    this.check(index);
    matrix.toArray(this.matrices, index * 16);
    this.touch(index);
  }

  getMatrixAt(index: number, matrix: Matrix4): Matrix4 {
    this.check(index);
    return matrix.fromArray(this.matrices, index * 16);
  }

  /** Tint instance `index` by `color`, as InstancedMesh.setColorAt does, in every level. */
  setColorAt(index: number, color: Color): void {
    this.check(index);
    if (!this.colors) {
      this.colors = new Float32Array(this.count * 4).fill(1);
      if (this.selection) this.useColors(this.selection, this.colors);
    }
    color.toArray(this.colors, index * 4);
    this.touch(index);
  }

  /** Instance `index`'s colour: white unless set. */
  getColorAt(index: number, color: Color): Color {
    this.check(index);
    return this.colors ? color.fromArray(this.colors, index * 4) : color.setRGB(1, 1, 1);
  }

  /** Carry `colors` with the instances from now on: every level's meshes draw them. */
  private useColors(selection: Selection, colors: Float32Array): void {
    selection.useColors(colors);
    for (const mesh of this.meshes.flat()) {
      mesh.instanceColor = selection.slots.colors;
      // Instance colours change the shader.
      for (const material of [mesh.material].flat()) material.needsUpdate = true;
    }
    this.touchAll();
  }

  /**
   * The finest level instance `index` drew in the last update, or null before the first
   * (or at scale 0). Inside a fade the next coarser level draws too.
   */
  levelOf(index: number): number | null {
    this.check(index);
    const { last } = this;
    if (!last.selected) return null;
    this.measure();
    const r = at(this.spheres, index * 4 + 3);
    if (r === 0) return null;
    const size = 2 * r * last.scale;
    const height = last.ortho ? size : size / Math.max(centre.fromArray(this.spheres, index * 4).distanceTo(last.eye), 1e-6);
    const level = levelAt(this.entries, height, last.forced);
    return last.fades && fadeProgress(this.entries, level, height) > 0 ? level.index - 1 : level.index;
  }

  private check(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) throw new Error(`InstancedLod: index ${index} is not in 0..${this.count - 1}`);
  }

  /** Instance `index` changed: mark it to measure and upload before the next selection. */
  private touch(index: number): void {
    this.low = Math.min(this.low, index);
    this.high = Math.max(this.high, index);
  }

  private touchAll(): void {
    this.low = 0;
    this.high = this.count - 1;
  }

  /** An instance's radius as its level meshes draw it: the source's, padded for sway. */
  private get drawRadius(): number {
    return this.sphere.radius * (1 + this.padding);
  }

  [WIND_BOUNDS](padding: number): void {
    this.padding = padding / this.sphere.radius;
    for (const mesh of this.meshes.flat()) {
      const draw = drawOf(mesh);
      if (draw?.kind === "instances") draw.radius = this.drawRadius;
    }
    this.bound();
  }

  /** Measure the spheres of the instances changed, upload them, and bound every instance again. */
  private measure(): void {
    const { low, high, selection } = this;
    if (low > high) return;
    this.low = Infinity;
    this.high = -1;
    const { center, radius } = this.sphere;
    for (let i = low; i <= high; i++) {
      instance.fromArray(this.matrices, i * 16);
      centre
        .copy(center)
        .applyMatrix4(instance)
        .toArray(this.spheres, i * 4);
      this.spheres[i * 4 + 3] = radius * instance.getMaxScaleOnAxis();
    }
    if (selection) {
      upload(selection.matrices, low, high);
      if (selection.colors) upload(selection.colors, low, high);
      selection.changed();
    }
    this.bound();
  }

  /** Bound every instance, padded for sway. */
  private bound(): void {
    // Plain numbers rather than Box3 calls: a crowd holds many instances.
    let [x0, y0, z0, x1, y1, z1] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let largest = 0;
    let smallest = Infinity;
    for (let i = 0; i < this.count; i++) {
      const r = at(this.spheres, i * 4 + 3);
      if (r === 0) continue;
      smallest = Math.min(smallest, r);
      const x = at(this.spheres, i * 4);
      const y = at(this.spheres, i * 4 + 1);
      const z = at(this.spheres, i * 4 + 2);
      x0 = Math.min(x0, x - r);
      y0 = Math.min(y0, y - r);
      z0 = Math.min(z0, z - r);
      x1 = Math.max(x1, x + r);
      y1 = Math.max(y1, y + r);
      z1 = Math.max(z1, z + r);
      largest = Math.max(largest, r);
    }
    this.largest = largest;
    this.smallest = largest === 0 ? 0 : smallest;
    if (largest === 0) {
      this.bounds.makeEmpty();
      return;
    }
    this.bounds.center.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.bounds.radius = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + largest * this.padding;
  }

  /** Sort the instances into levels for `camera`; three's renderer calls this itself while `autoUpdate`. */
  update(camera: Camera): void {
    const { entries, selection } = this;
    if (!selection || inShadowPass(this)) return;
    validate(entries);
    if (this.forceLevel !== null && !entries[this.forceLevel]) throw new Error(`Lod: forceLevel ${this.forceLevel} is not a level`);
    this.measure();
    const height = viewportHeight(camera);
    view.begin(camera, height ?? TYPICAL_HEIGHT, this.forceLevel);
    tintLevels(entries, Lod.debug);
    const worldScale = this.matrixWorld.getMaxScaleOnAxis();
    const scale = view.scale * Lod.quality * (view.ortho ? worldScale : 1);
    const { last } = this;
    last.eye.copy(view.eye).applyMatrix4(inverse.copy(this.matrixWorld).invert());
    Object.assign(last, { selected: true, scale, ortho: view.ortho, fades: view.fades, forced: this.forceLevel });
    selection.aim(last.eye, scale, view.ortho, view.fades, this.forceLevel, entries);
    // Selected only when something may draw: an InstancedLod with every level hidden
    // keeps its last selection.
    if (this.showLevels(height !== null)) pending.add(selection);
  }

  /**
   * Show only the level meshes an instance may draw in for the last view, by the heights
   * on screen the instances can have within the bounds: the others would be empty draws,
   * in the view and in every shadow map. Whether any shows.
   */
  private showLevels(measured: boolean): boolean {
    const { entries, last, bounds } = this;
    // Before the camera's first frame, every level: its height is only a guess.
    let finest = measured ? Infinity : 0;
    let coarsest = measured ? -1 : entries.length - 1;
    if (measured && !bounds.isEmpty()) {
      const distance = last.eye.distanceTo(bounds.center);
      const near = last.ortho ? 1 : Math.max(distance - bounds.radius, 1e-6);
      const far = last.ortho ? 1 : distance + bounds.radius;
      const highest = (2 * this.largest * last.scale) / near;
      const top = levelAt(entries, highest, last.forced);
      finest = last.fades && fadeProgress(entries, top, highest) > 0 ? top.index - 1 : top.index;
      coarsest = levelAt(entries, (2 * this.smallest * last.scale) / far, last.forced).index;
    }
    this.reach(measured);
    let shown = false;
    this.meshes.forEach((meshes, level) => {
      const visible = level >= finest && level <= coarsest;
      for (const mesh of meshes) mesh.visible = visible;
      shown ||= visible && meshes.length > 0;
    });
    return shown;
  }

  /**
   * Bound each level by how far from the camera its instances can be: no smaller on
   * screen than the next level's fade begins (the last level, any size). A fine level of
   * a large crowd is then culled as a small object near the camera, in the view and in
   * every shadow map.
   */
  private reach(measured: boolean): void {
    const { entries, last, bounds } = this;
    this.reaches.forEach((sphere, level) => {
      sphere.copy(bounds);
      const next = entries[level + 1];
      if (!measured || last.ortho || last.forced !== null || !next || bounds.isEmpty()) return;
      const smallest = next.maxPixels * (1 - FADE);
      const radius = (2 * this.largest * last.scale) / smallest + this.largest * (1 + this.padding);
      if (radius < bounds.radius) sphere.set(last.eye, radius);
    });
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
    this.touchAll();
    if (source.entries.length > 0) this.build(cloneLevels(source.entries));
    copyThresholds(source.entries, this.entries);
    this.forceLevel = source.forceLevel;
    this.autoUpdate = source.autoUpdate;
    copyWind(source, this);
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
    // An ImpostorMesh frees its own material and geometry; the other meshes' faded
    // materials go with the levels' originals.
    for (const mesh of this.meshes.flat()) {
      mesh.dispose();
      if (!isImpostorMesh(mesh)) mesh.geometry.dispose();
    }
    if (this.selection) pending.delete(this.selection);
    this.selection?.dispose();
    this.selection = null;
    for (const { object } of this.entries) disposeTree(object);
  }
}

function at<T>(values: ArrayLike<T>, i: number): T {
  const value = values[i];
  if (value === undefined) throw new Error(`InstancedLod: index ${i} out of range`);
  return value;
}

/** Upload items `low..high` of `attribute`, with any ranges not uploaded yet. */
function upload(attribute: BufferAttribute, low: number, high: number): void {
  attribute.addUpdateRange(low * attribute.itemSize, (high - low + 1) * attribute.itemSize);
  attribute.needsUpdate = true;
}

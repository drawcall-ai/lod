import {
  Box3,
  InstancedMesh,
  type Color,
  Matrix4,
  Object3D,
  Ray,
  Sphere,
  Vector3,
  type Camera,
  type ComputeNode,
  type Intersection,
  type Mesh,
  type Raycaster,
} from "three/webgpu";
import { boundingBox, measureLevels, prepareBounds } from "../bounds.js";
import { disposeTree } from "../dispose.js";
import { drawOf, setDraw } from "../fade.js";
import { placeInterior } from "../baked/interior/material.js";
import { impostorInstances, type ImpostorMesh } from "../impostor/mesh/index.js";
import {
  Level,
  cloneLevels,
  copyThresholds,
  estimate,
  fadeProgress,
  levelAt,
  tintLevels,
  validate,
  type LodLevel,
  type LevelInput,
  levelObjects,
  applyThresholds,
} from "../levels.js";
import { Lod } from "../lod.js";
import { type LazyLevel } from "../lazy.js";
import { Residency, type LevelsEventMap } from "../residency.js";
import { gpuRenderer, inShadowPass, isLazyLevel, isImpostorMesh, sameClass } from "../three.js";
import { TYPICAL_HEIGHT, View, viewportHeight, watchViewport, watchContext, unwatchContext, inView, type RenderContext } from "../view.js";
import { compileLevel } from "../install.js";
import { WIND_BOUNDS } from "../wind/hooks.js";
import { copyWind, refreshWind } from "../wind/index.js";
import { groupMaterial, indirect, placed, parts, type Part } from "./meshes.js";
import { Bounds, stretch } from "./bounds.js";
import { Dirty, upload } from "./dirty.js";
import { ARGS_BYTES, Selection } from "./select.js";

const IDENTITY = new Matrix4();
const view = new View();
const inverse = new Matrix4();
const ray = new Ray();
const sphere = new Sphere();
const instance = new Matrix4();
const world = new Matrix4();
const hits: Intersection[] = [];

/**
 * Selections due before the next draw of any InstancedLod: the first level mesh to draw
 * runs them all in one compute call (each call has a cost of its own: an encoder, a
 * pass, a submit). Each renderer runs those its own buffers are not current with.
 */
const selections = new Set<Selection>();
const passes: ComputeNode[] = [];

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
 * (see select.ts) and every mesh/material group of a level draws its instances in one
 * indirect draw; an instance near a switch is in both neighbours and they split its pixels with
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
 *
 * Requires the WebGPU feature `indirect-first-instance`. Sequential camera renders are
 * supported; a render nested inside another replaces the outer view's selection. Exclude
 * this object from nested reflection or cube-camera renders using camera layers.
 */
export class InstancedLod extends Object3D<LevelsEventMap> {
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
  private readonly residency = new Residency(
    this.entries,
    (index, lazy, context) => this.install(index, lazy, context),
    () => {
      this.selection?.route(this.residency.fallback, true);
      this.dispatchEvent({ type: "levelschange" });
    },
    (error) => this.dispatchEvent({ type: "levelserror", error }),
  );
  private readonly offsets = new Map<LevelMesh, number>();
  private disposed = false;
  /** Instance matrices, 16 floats each: the selection uploads them from here. */
  private readonly matrices: Float32Array;
  /** Instance colours, 4 floats each, once `setColorAt` was called. */
  private colors: Float32Array | null = null;
  /** Each instance's bounding sphere, centre and radius, in the InstancedLod's space. */
  private readonly spheres: Float32Array;
  /** Bounding sphere of the source in an instance's space. */
  private readonly sphere = new Sphere();
  /** Every placed level, kept separate from the source sphere used for LOD selection. */
  private readonly envelope = new Box3();
  private readonly rest = new Sphere();
  /** Around every instance; each level may use tighter bounds. */
  readonly bounds = new Sphere();
  /** Per level, what its meshes are culled by: `bounds`, or less where its instances must be near the camera. */
  private readonly reaches: Sphere[] = [];
  /** Logical demand at the initial default viewport, separate from first-draw visibility. */
  private readonly demand: Sphere[] = [];
  /** Source-radius padding for the shadow caster cutoff; culling pads every level separately. */
  private padding = 0;
  private readonly matrixChanges: Dirty;
  private readonly colorChanges: Dirty;
  private blocks: Bounds;
  private readonly last: Selected = { selected: false, eye: new Vector3(), scale: 0, ortho: false, fades: false, forced: null };

  get pending(): boolean {
    return this.residency.pending;
  }
  get error(): Error | undefined {
    return this.residency.error;
  }

  /** `levels[0]` is the source, or share the levels and thresholds of a Lod. */
  constructor(levels: LevelInput | Lod = [], count = 0) {
    super();
    if (!Number.isInteger(count) || count < 0) throw new Error(`InstancedLod: count must be an integer >= 0, got ${count}`);
    this.levels = this.entries;
    this.count = count;
    this.matrices = new Float32Array(count * 16);
    this.spheres = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) IDENTITY.toArray(this.matrices, i * 16);
    this.matrixChanges = new Dirty(count);
    this.colorChanges = new Dirty(count);
    this.matrixChanges.all();
    const input = levels instanceof Lod ? levels.levels : levels;
    const objects = levelObjects(input);
    const draws = objects.length > 0 ? this.build(objects) : 0;
    applyThresholds(input, this.entries);
    this.blocks = new Bounds(this.matrices, this.spheres, this.sphere, this.bounds, draws, this.rest);
  }

  private build(objects: Object3D[]): number {
    if (objects.length === 0) throw new Error("InstancedLod: needs at least the source level");
    if (objects.every(isLazyLevel)) throw new Error("InstancedLod: at least one level must be eager");
    const { own, placed } = measureLevels(objects, "InstancedLod");
    this.sphere.copy(placed);
    objects.forEach((object, i) => {
      this.entries.push(new Level(object, i, false, this.entries));
      this.reaches.push(new Sphere());
      this.demand.push(new Sphere());
      if (object.matrixAutoUpdate) object.updateMatrix();
      this.envelope.union(boundingBox(object).applyMatrix4(object.matrix));
    });
    estimate(this.entries, 2 * own.radius);
    validate(this.entries);
    this.residency.reset();
    this.boundLevels();
    const templates = objects.map((object, i) => (isLazyLevel(object) ? [] : parts(object, i)));
    this.probe(templates[0] ?? []);
    const draws = templates.flatMap((parts) => parts.map((part) => part.draw));
    const selection = new Selection(
      this.matrices,
      this.sphere,
      templates.map((parts, i) => parts.length > 0 || isLazyLevel(at(objects, i))),
      draws,
      this.residency.fallback,
    );
    this.selection = selection;
    if (this.colors) selection.useColors(this.colors);
    let offset = 0;
    templates.forEach((parts, i) => {
      const level = at(this.entries, i);
      this.meshes[i] = parts.map((part) => {
        const mesh = this.instance(level, part.template, part.placement, part.group, offset, selection);
        offset += ARGS_BYTES;
        this.add(mesh);
        return mesh;
      });
    });
    if (draws.length === 0) watchContext(this);
    return draws.length;
  }

  private probe(parts: readonly Part[]): void {
    const seen = new Set<Mesh>();
    for (const { template, placement } of parts) {
      if (seen.has(template)) continue;
      seen.add(template);
      this.probes.push({ mesh: template, placement });
    }
  }

  /** Compile only the arriving level; bounds and instance buffers stay fixed. */
  private async install(index: number, lazy: LazyLevel, context: RenderContext): Promise<void> {
    const selection = this.selection;
    const template = lazy.object;
    if (!selection || !template) throw new Error("InstancedLod: missing selection or decoded level");
    const staged = new Object3D();
    const level = at(this.entries, index);
    if (lazy.matrixAutoUpdate) lazy.updateMatrix();
    prepareBounds(template, lazy.box);
    const found = parts(template, index, lazy.matrix);
    let offset = selection.append(found.map((part) => part.draw));
    // A lazy level has no upfront mesh count, so its indirect draw table can relocate.
    for (const [mesh, offset] of this.offsets) mesh.geometry.setIndirect(selection.args, selection.argsOffset + offset);
    const meshes = found.map((part) => {
      const mesh = this.instance(level, part.template, part.placement, part.group, offset, selection);
      offset += ARGS_BYTES;
      staged.add(mesh);
      return mesh;
    });
    try {
      refreshWind(this, staged);
      await compileLevel(staged, context);
    } catch (error) {
      for (const mesh of meshes) this.free(mesh);
      throw error;
    }
    if (this.disposed) {
      for (const mesh of meshes) this.free(mesh);
      return;
    }
    if (meshes.length > 0) unwatchContext(this);
    if (index === 0) this.probe(found);
    this.meshes[index] = meshes;
    this.add(...meshes);
  }

  /** Metadata includes unloaded levels, so later arrivals cannot enlarge this envelope. */
  private boundLevels(): void {
    this.rest.copy(this.sphere);
    if (this.envelope.isEmpty()) return;
    const { center } = this.rest;
    const { min, max } = this.envelope;
    this.rest.radius = Math.max(
      this.rest.radius,
      Math.hypot(
        Math.max(Math.abs(min.x - center.x), Math.abs(max.x - center.x)),
        Math.max(Math.abs(min.y - center.y), Math.abs(max.y - center.y)),
        Math.max(Math.abs(min.z - center.z), Math.abs(max.z - center.z)),
      ),
    );
  }

  /** Material group `group` of `template` drawn for every instance in `level`'s slots, from indirect draw arguments at byte `offset`. */
  private instance(level: Level, template: Mesh, placement: Matrix4, group: number, offset: number, selection: Selection): LevelMesh {
    // An impostor card is placed in the shader; any other mesh draws its geometry moved
    // into the instance's space, so the instance matrix is all it needs.
    const mesh: LevelMesh = isImpostorMesh(template)
      ? impostorInstances(template, 0, placement)
      : new InstancedMesh(placed(template.geometry, placement), groupMaterial(template, group), 0);
    // Indirect arguments supply the actual count. A card's public count is otherwise
    // used by Three to specialize its shader for one object's storage bindings.
    mesh.count = isImpostorMesh(mesh) ? 1 : this.count;
    mesh.geometry = indirect(mesh.geometry, selection, offset);
    this.offsets.set(mesh, offset);
    this.bind(mesh, level, selection, offset);
    if (!isImpostorMesh(template)) placeInterior(mesh, placement);
    mesh.name = template.name;
    mesh.castShadow = template.castShadow;
    mesh.receiveShadow = template.receiveShadow;
    mesh.boundingSphere = at(this.reaches, level.index);
    watchViewport(mesh);
    const previous = mesh.onBeforeRender;
    // Selected once per view, before the first level mesh draws: in the view, or in a
    // shadow pass that comes first. The GPU runs it before anything drawn after it.
    mesh.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
      if (this.disposed) return;
      previous.call(mesh, renderer, scene, camera, geometry, material, group);
      const gpu = gpuRenderer(renderer);
      // A caster outside the viewing frustum still needs its selection in a shadow draw.
      selections.add(selection);
      // Each level's draws start at its slots (see select.ts).
      if (!gpu.hasFeature("indirect-first-instance")) throw new Error("InstancedLod: needs the GPU feature indirect-first-instance, which this device lacks");
      passes.length = 0;
      for (const due of selections) passes.push(...due.take(gpu));
      selections.clear();
      if (passes.length > 0) gpu.compute(passes);
    };
    const after = mesh.onAfterRender;
    mesh.onAfterRender = (renderer, scene, camera, geometry, material, group) => {
      after.call(mesh, renderer, scene, camera, geometry, material, group);
      if (!inShadowPass(scene)) this.residency.drawn(camera, mesh);
    };
    return mesh;
  }

  private bind(mesh: LevelMesh, level: Level, selection: Selection, offset: number): void {
    mesh.geometry.setIndirect(selection.args, selection.argsOffset + offset);
    mesh.instanceMatrix = selection.slots.matrices;
    mesh.instanceColor = selection.slots.colors;
    setDraw(mesh, { kind: "instances", fades: selection.slots.fades, radius: this.drawRadius, tint: level.tint });
  }

  setMatrixAt(index: number, matrix: Matrix4): void {
    this.check(index);
    matrix.toArray(this.matrices, index * 16);
    this.matrixChanges.add(index);
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
    this.colorChanges.add(index);
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
      if (!isImpostorMesh(mesh)) for (const material of [mesh.material].flat()) material.needsUpdate = true;
    }
    this.colorChanges.all();
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
    const offset = index * 4;
    const r = at(this.spheres, offset + 3);
    if (r === 0) return null;
    let height = 2 * r * last.scale;
    if (!last.ortho) {
      const x = this.spheres[offset];
      const y = this.spheres[offset + 1];
      const z = this.spheres[offset + 2];
      if (x === undefined || y === undefined || z === undefined) throw new Error(`InstancedLod: missing sphere ${index}`);
      const dx = x - last.eye.x;
      const dy = y - last.eye.y;
      const dz = z - last.eye.z;
      height /= Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-6);
    }
    const level = levelAt(this.entries, height, last.forced);
    const selected = last.fades && fadeProgress(this.entries, level, height) > 0 ? level.index - 1 : level.index;
    return at(this.residency.fallback, selected);
  }

  private check(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) throw new Error(`InstancedLod: index ${index} is not in 0..${this.count - 1}`);
  }

  /** Source radius padded for the level shaders' shadow caster cutoff. */
  private get drawRadius(): number {
    return this.sphere.radius * (1 + this.padding);
  }

  [WIND_BOUNDS](padding: number, slope: number, baseY: number): void {
    this.padding = padding / this.sphere.radius;
    for (const mesh of this.meshes.flat()) {
      const draw = drawOf(mesh);
      if (draw?.kind === "instances") draw.radius = this.drawRadius;
    }
    // The wind shape comes from the source, but taller/offset levels can sway farther.
    const reach = slope * Math.max(Math.abs(this.envelope.min.y - baseY), Math.abs(this.envelope.max.y - baseY));
    this.blocks.pad(this.rest.radius > 0 ? reach / this.rest.radius : 0);
    this.blocks.refit();
  }

  /** Measure only changed matrices; matrix and colour uploads have separate ranges. */
  private measure(): void {
    if (this.matrixChanges.empty && this.colorChanges.empty) return;
    this.measureChanges();
  }

  // Keep the closure-bearing work out of the unchanged path: V8 can allocate a
  // lexical context on entry even when a function returns before its callbacks.
  private measureChanges(): void {
    const { selection } = this;
    const matricesChanged = !this.matrixChanges.empty;
    this.matrixChanges.drain((start, end) => {
      this.blocks.measure(start, end);
      if (selection) upload(selection.matrices, start, end);
    });
    this.colorChanges.drain((start, end) => {
      if (selection?.colors) upload(selection.colors, start, end);
    });
    selection?.changed();
    if (matricesChanged) this.blocks.refit();
  }

  /** Sort instances for `camera`; demand begins after its first drawing context exists. */
  update(camera: Camera): void {
    if (this.disposed || inShadowPass(this)) return;
    const { entries, selection } = this;
    if (!selection) return;
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
    last.selected = true;
    last.scale = scale;
    last.ortho = view.ortho;
    last.fades = view.fades;
    last.forced = this.forceLevel;
    const stable = this.blocks.select(entries, last, this.reaches, height !== null, this.matrixWorld);
    const { residency } = this;
    const progress = residency.progress;
    if (selection.progress.value !== progress) {
      selection.progress.value = progress;
      selection.changed();
    }
    const needed: number[] = [];
    if (this.bounds.isEmpty()) {
      // Reusable crowds can be populated and drawn in the same frame.
      for (const level of entries) if (!isLazyLevel(level.object)) needed.push(level.index);
    } else if (residency.needsDemand(camera, this.meshes)) {
      this.blocks.demand(entries, last, this.demand, this.matrixWorld);
      for (let i = this.reaches.length - 1; i >= 0; i--) {
        const reach = at(this.reaches, i);
        if (inView(camera, this.matrixWorld, at(this.demand, i))) needed.push(i);
        const target = at(residency.fallback, i);
        if (progress < 1) {
          const previous = at(residency.previous, i);
          if (previous !== target) at(this.reaches, previous).union(reach);
        }
        if (target !== i) {
          at(this.reaches, target).union(reach);
          reach.makeEmpty();
        }
      }
    }
    residency.demand(camera, needed);
    residency.update(camera, this.meshes);
    selection.aim(last.eye, scale, view.ortho, view.fades, this.forceLevel, entries, stable);
    // Selected only when something may draw: an InstancedLod with every level hidden
    // keeps its last selection.
    if (this.showLevels(camera)) selections.add(selection);
    else selections.delete(selection);
  }

  /** Only levels whose conservative bounds contain a possible selected instance. */
  private showLevels(camera: Camera): boolean {
    let shown = false;
    for (let level = 0; level < this.meshes.length; level++) {
      const visible = !at(this.reaches, level).isEmpty();
      const meshes = at(this.meshes, level);
      for (const mesh of meshes) mesh.visible = visible;
      shown ||= visible && meshes.length > 0 && inView(camera, this.matrixWorld, at(this.reaches, level));
    }
    return shown;
  }

  /**
   * Hits every instance's source level, with `instanceId` set; `object` is this
   * InstancedLod. Meshes of the source on layers the raycaster does not test are skipped.
   */
  override raycast(raycaster: Raycaster, intersects: Intersection[]): boolean {
    ray.copy(raycaster.ray).applyMatrix4(inverse.copy(this.matrixWorld).invert());
    for (let i = 0; i < this.count; i++) {
      instance.fromArray(this.matrices, i * 16);
      sphere.center.copy(this.rest.center).applyMatrix4(instance);
      sphere.radius = this.rest.radius * stretch(instance);
      if (!ray.intersectsSphere(sphere)) continue;
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
    this.matrixChanges.all();
    if (this.colors) this.colorChanges.all();
    const draws = source.entries.length > 0 ? this.build(cloneLevels(source.entries)) : 0;
    this.blocks = new Bounds(this.matrices, this.spheres, this.sphere, this.bounds, draws, this.rest);
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
    if (this.disposed) return;
    this.disposed = true;
    unwatchContext(this);
    this.residency.dispose(() => {
      this.clearDraws();
      for (const { object } of this.entries) disposeTree(object);
    });
  }

  private free(mesh: LevelMesh): void {
    this.offsets.delete(mesh);
    // ImpostorMesh.dispose also destroys instance buffers; the Selection owns ours.
    if (isImpostorMesh(mesh)) mesh.material.release();
    else mesh.dispose();
    mesh.geometry.dispose();
  }

  private clearDraws(): void {
    // An ImpostorMesh frees its own material and geometry; the other meshes' faded
    // materials go with the levels' originals.
    for (const mesh of this.meshes.flat()) {
      this.remove(mesh);
      this.free(mesh);
    }
    if (this.selection) selections.delete(this.selection);
    this.selection?.dispose();
    this.selection = null;
    this.meshes.length = 0;
    this.offsets.clear();
  }
}

function at<T>(values: ArrayLike<T>, i: number): T {
  const value = values[i];
  if (value === undefined) throw new Error(`InstancedLod: index ${i} out of range`);
  return value;
}

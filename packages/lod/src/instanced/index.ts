import { Box3, type Color, Matrix4, Object3D, Sphere, Vector3, type Camera, type Intersection, type Raycaster } from "three/webgpu";
import { at } from "../at.js";
import { levelBox, measureLevels, prepareBounds } from "../bounds.js";
import { disposeCopies } from "../dispose.js";
import { Level, cloneLevels, estimate, fadeProgress, levelAt, tintLevels, validate, type LevelView, type LodLevel } from "../levels.js";
import { Lod } from "../lod.js";
import { Residency, type LevelsEventMap } from "../residency.js";
import { inShadowPass, sameClass } from "../three.js";
import { TYPICAL_HEIGHT, View, viewportHeight, watchContext, unwatchContext, inView, type RenderContext } from "../view.js";
import { compileLevel } from "../compile.js";
import { WIND_BOUNDS } from "../wind/hooks.js";
import { copyWind, refreshWind } from "../wind/index.js";
import { Meshes } from "./meshes.js";
import { parts } from "./parts.js";
import { Blocks, type BlockView } from "./blocks.js";
import { Probes } from "./raycast.js";
import { ARGS_BYTES } from "./args.js";
import { Selection } from "./select.js";
import { Store } from "./store.js";

const view = new View();
const inverse = new Matrix4();

/** The last view `update` selected for, in the InstancedLod's space, for `levelOf`. */
interface Selected extends BlockView {
  /** Whether there was one. */
  selected: boolean;
}

/**
 * Independently selected copies of one object, batched into indirect draws per view.
 * Thresholds, fades, global settings and shadows follow Lod. Each level's bounds tighten
 * to the region where its instances can draw. Instance matrices may scale arbitrarily;
 * the crowd's own transform and its parents should scale uniformly. Scale 0 draws nothing.
 *
 * Level templates are cloned, then their meshes are instanced. Skinned meshes,
 * InstancedMeshes (except ImpostorMesh) and nested Lods are unsupported. For external
 * detail, leave level 0 empty and draw the instances that `levelOf` reports there.
 *
 * Requires WebGPU `indirect-first-instance`. Sequential cameras are supported; nested
 * renders replace the outer selection, so exclude this crowd with camera layers.
 */
export class InstancedLod extends Object3D<LevelsEventMap> {
  readonly isLOD = true;
  readonly isInstancedLod = true;
  /** Let the renderer call `update` with its camera every frame. */
  autoUpdate = true;
  /** Draw only this level for every instance, without fades. */
  forceLevel: number | null = null;
  readonly levels: readonly LevelView[];
  readonly count: number;

  private readonly entries: Level[] = [];
  private readonly probes: Probes;
  private selection: Selection | null = null;
  private meshes: Meshes | null = null;
  private readonly residency = new Residency(
    this.entries,
    (level, object, context) => this.install(level, object, context),
    () => {
      this.selection?.route(this.residency.fallback, true);
      this.dispatchEvent({ type: "levelschange" });
    },
    (error) => this.dispatchEvent({ type: "levelserror", error }),
  );
  private disposed = false;
  private readonly store: Store;
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
  private blocks: Blocks;
  private readonly last: Selected = { selected: false, eye: new Vector3(), scale: 0, ortho: false, fades: false, forced: null };

  get pending(): boolean {
    return this.residency.pending;
  }
  get error(): Error | undefined {
    return this.residency.error;
  }

  /** `levels[0]` is the source. Empty only as the target of `copy`. */
  constructor(levels: readonly LodLevel[] = [], count = 0) {
    super();
    if (!Number.isInteger(count) || count < 0) throw new Error(`InstancedLod: count must be an integer >= 0, got ${count}`);
    this.levels = this.entries;
    this.count = count;
    this.store = new Store(count);
    this.probes = new Probes(this.store.matrices, this.rest);
    const draws = levels.length > 0 ? this.build(levels) : 0;
    this.blocks = new Blocks(this.store.matrices, this.store.spheres, this.sphere, this.bounds, draws, this.rest);
  }

  private build(inputs: readonly LodLevel[]): number {
    const { own, placed } = measureLevels(inputs, "InstancedLod");
    this.sphere.copy(placed);
    inputs.forEach((input, i) => {
      this.entries.push(new Level(input, i, this.entries));
      this.reaches.push(new Sphere());
      this.demand.push(new Sphere());
      this.envelope.union(levelBox(input));
    });
    estimate(this.entries, 2 * own.radius);
    validate(this.entries);
    this.residency.reset();
    this.boundLevels();
    const templates = this.entries.map(({ object }, i) => (object ? parts(object, i) : []));
    this.probes.add(templates[0] ?? []);
    const draws = templates.flatMap((parts) => parts.map((part) => part.draw));
    const selection = new Selection(
      this.store.matrices,
      this.sphere,
      templates.map((parts, i) => parts.length > 0 || at(inputs, i).box?.isEmpty() === false),
      draws,
      this.residency.fallback,
    );
    this.selection = selection;
    this.store.attach(selection);
    const meshes = new Meshes(selection, this.reaches, this.drawRadius, {
      live: () => !this.disposed,
      drawn: (camera, mesh) => this.residency.drawn(camera, mesh),
    });
    this.meshes = meshes;
    let offset = 0;
    templates.forEach((parts, i) => {
      const made = meshes.make(at(this.entries, i), parts, offset);
      offset += made.length * ARGS_BYTES;
      meshes.byLevel[i] = made;
      for (const mesh of made) this.add(mesh);
    });
    if (draws.length === 0) watchContext(this);
    return draws.length;
  }

  /** Compile only the arriving level; bounds and instance buffers stay fixed. */
  private async install(level: Level, template: Object3D, context: RenderContext): Promise<void> {
    const { selection, meshes } = this;
    if (!selection || !meshes) throw new Error("InstancedLod: missing selection");
    const staged = new Object3D();
    const object = template.clone();
    if (level.box) prepareBounds(object, level.box);
    const found = parts(object, level.index);
    const offset = selection.append(found.map((part) => part.draw));
    // A deferred level has no upfront mesh count, so its indirect draw table can relocate.
    meshes.relocate();
    const made = meshes.make(level, found, offset);
    for (const mesh of made) staged.add(mesh);
    const abandon = () => {
      for (const mesh of made) meshes.free(mesh);
      disposeCopies(object);
    };
    try {
      refreshWind(this, staged);
      await compileLevel(staged, context);
    } catch (error) {
      abandon();
      throw error;
    }
    if (this.disposed) {
      abandon();
      return;
    }
    level.object = object;
    if (made.length > 0) unwatchContext(this);
    if (level.index === 0) this.probes.add(found);
    meshes.byLevel[level.index] = made;
    for (const mesh of made) this.add(mesh);
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

  setMatrixAt(index: number, matrix: Matrix4): void {
    this.store.setMatrix(index, matrix);
  }

  getMatrixAt(index: number, matrix: Matrix4): Matrix4 {
    return this.store.getMatrix(index, matrix);
  }

  /** Tint instance `index` by `color`, as InstancedMesh.setColorAt does, in every level. */
  setColorAt(index: number, color: Color): void {
    const first = this.store.colors === null;
    this.store.setColor(index, color);
    if (first) this.meshes?.recolor();
  }

  /** Instance `index`'s colour: white unless set. */
  getColorAt(index: number, color: Color): Color {
    return this.store.getColor(index, color);
  }

  /**
   * The finest level instance `index` drew in the last update, or null before the first
   * (or at scale 0). Inside a fade the next coarser level draws too.
   */
  levelOf(index: number): number | null {
    const { last, store } = this;
    store.check(index);
    if (!last.selected) return null;
    store.measure(this.blocks);
    const offset = index * 4;
    const r = at(store.spheres, offset + 3);
    if (r === 0) return null;
    let height = 2 * r * last.scale;
    if (!last.ortho) {
      const dx = at(store.spheres, offset) - last.eye.x;
      const dy = at(store.spheres, offset + 1) - last.eye.y;
      const dz = at(store.spheres, offset + 2) - last.eye.z;
      height /= Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-6);
    }
    const level = levelAt(this.entries, height, last.forced);
    const selected = last.fades && fadeProgress(this.entries, level, height) > 0 ? level.index - 1 : level.index;
    const ready = at(this.residency.fallback, selected);
    return ready < 0 ? null : ready;
  }

  /** Source radius padded for the level shaders' shadow caster cutoff. */
  private get drawRadius(): number {
    return this.sphere.radius * (1 + this.padding);
  }

  [WIND_BOUNDS](padding: number, slope: number, baseY: number): void {
    this.padding = padding / this.sphere.radius;
    this.meshes?.setRadius(this.drawRadius);
    // The wind shape comes from the source, but taller/offset levels can sway farther.
    const reach = slope * Math.max(Math.abs(this.envelope.min.y - baseY), Math.abs(this.envelope.max.y - baseY));
    this.blocks.pad(this.rest.radius > 0 ? reach / this.rest.radius : 0);
    this.blocks.refit();
  }

  /** Sort instances for `camera`; demand begins after its first drawing context exists. */
  update(camera: Camera): void {
    if (this.disposed || inShadowPass(this)) return;
    const { entries, selection, meshes } = this;
    if (!selection || !meshes) return;
    validate(entries);
    if (this.forceLevel !== null && !entries[this.forceLevel]) throw new Error(`Lod: forceLevel ${this.forceLevel} is not a level`);
    this.store.measure(this.blocks);
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
      for (const level of entries) if (level.object) needed.push(level.index);
    } else if (residency.needsDemand(camera, meshes.byLevel)) {
      this.blocks.demand(entries, last, this.demand, this.matrixWorld);
      // Coarsest first, so its load starts first.
      for (let i = this.demand.length - 1; i >= 0; i--) if (inView(camera, this.matrixWorld, at(this.demand, i))) needed.push(i);
      this.reroute(progress);
    }
    residency.demand(camera, needed);
    residency.update(camera, meshes.byLevel);
    selection.aim(last.eye, scale, view.ortho, view.fades, this.forceLevel, entries, stable);
    // Selected only when something may draw: an InstancedLod with every level hidden
    // keeps its last selection.
    meshes.schedule(meshes.show(camera, this.matrixWorld));
  }

  /** Move each level's reach to the level that draws in its place: its fallback, and during a handover also its previous one. */
  private reroute(progress: number): void {
    const { fallback, previous } = this.residency;
    for (let i = this.reaches.length - 1; i >= 0; i--) {
      const reach = at(this.reaches, i);
      const target = at(fallback, i);
      const before = progress < 1 ? at(previous, i) : -1;
      if (before >= 0 && before !== target) at(this.reaches, before).union(reach);
      if (target === i) continue;
      if (target >= 0) at(this.reaches, target).union(reach);
      reach.makeEmpty();
    }
  }

  /**
   * Hits every instance's source level, with `instanceId` set; `object` is this
   * InstancedLod. Meshes of the source on layers the raycaster does not test are skipped.
   */
  override raycast(raycaster: Raycaster, intersects: Intersection[]): boolean {
    this.probes.raycast(this, raycaster, intersects);
    return false;
  }

  /**
   * Copies `source`'s levels, instances and settings into this empty InstancedLod of the
   * same count (it throws otherwise); the copy shares geometry and textures with `source`.
   */
  override copy(source: InstancedLod): this {
    if (this.entries.length > 0 || this.count !== source.count) throw new Error("InstancedLod.copy: copy into an empty InstancedLod of the same count");
    super.copy(source, false);
    this.store.copy(source.store);
    const draws = source.entries.length > 0 ? this.build(cloneLevels(source.entries)) : 0;
    this.blocks = new Blocks(this.store.matrices, this.store.spheres, this.sphere, this.bounds, draws, this.rest);
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

  /** Release drawables and templates only after every owner sharing their geometry, materials and textures has stopped drawing. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    unwatchContext(this);
    this.residency.dispose(() => {
      this.clearDraws();
      for (const { object } of this.entries) if (object) disposeCopies(object);
    });
  }

  private clearDraws(): void {
    this.meshes?.dispose();
    this.meshes = null;
    this.selection?.dispose();
    this.selection = null;
    this.store.attach(null);
  }
}

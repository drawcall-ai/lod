import { type Color, Frustum, Matrix4, type Object3D, Sphere, Vector3, type Camera, type Intersection, type Raycaster } from "three/webgpu";
import { at } from "../at.js";
import { disposeCopies } from "../dispose.js";
import { Level, cloneLevels, estimate, fadeProgress, levelAt, tintLevels, validate, type LodLevel } from "../levels.js";
import { Lod } from "../lod.js";
import { Owner, type LodOptions } from "../owner.js";
import { inShadowPass, sameClass } from "../three.js";
import { TYPICAL_HEIGHT, View, viewportHeight, type RenderContext } from "../view.js";
import { compileLevel } from "../compile.js";
import { refreshWind } from "../wind/index.js";
import { Meshes } from "./meshes.js";
import { parts } from "./parts.js";
import { Blocks } from "./blocks.js";
import { Extent } from "./extent.js";
import { Probes } from "./raycast.js";
import { checkContact, type InstancedContact } from "./contact.js";
import type { RangeAim } from "./kernel.js";
import { checkRange, keptFraction, survivorScale, type InstancedRange } from "./range.js";
import { Selection, sight, type Aim } from "./select.js";
import { Store, type ChunkData, type InstancedChunk } from "./store.js";

const view = new View();
const inverse = new Matrix4();
const origin = new Vector3();

/**
 * Independently selected copies of one object, batched into indirect draws per view. Copies
 * arrive and leave in chunks (see `addChunk`); a `range` thins them out with distance.
 * Thresholds, fades and global settings follow Lod. Each view draws only the instances in
 * its frustum, and each shadow map is a view of its own: it draws the casters in its
 * frustum, each at the level its texels resolve, as an orthographic view would (an
 * instance smaller than a texel casts nothing). Each level's bounds tighten to the region
 * where its instances can draw. Instance matrices may scale arbitrarily;
 * the crowd's own transform and its parents should scale uniformly. Scale 0 draws nothing.
 *
 * Level templates are cloned, then their meshes are instanced. Skinned meshes,
 * InstancedMeshes (except ImpostorMesh) and nested Lods are unsupported. For external
 * detail, leave level 0 empty and draw the instances that `levelOf` reports there.
 *
 * Requires WebGPU `indirect-first-instance`. Sequential cameras are supported; nested
 * renders replace the outer selection, so exclude this crowd with camera layers.
 */
export class InstancedLod extends Owner {
  readonly isInstancedLod = true;
  /** How far from a camera its instances draw, thinning out before it, in every view; null draws them at any distance. */
  range: InstancedRange | null = null;
  /**
   * A soft contact shadow under each instance it draws within a distance of the viewing camera, so that copies sit on
   * the ground; null draws none. A contact shows exactly when its instance does, `range` and frustum included.
   */
  contact: InstancedContact | null = null;

  private readonly probes: Probes;
  private selection: Selection | null = null;
  private meshes: Meshes | null = null;
  private readonly store: Store;
  private readonly extent = new Extent();
  /** Around every instance; each level may use tighter bounds. */
  readonly bounds = new Sphere();
  private blocks: Blocks;
  /** Indirect draws of every level, which decide the blocks' leaf size. */
  private draws = 0;
  /** The blocks' wind padding (see `Blocks.pad`). */
  private padding = 0;
  /** The range selected with last, in this crowd's space, or none. */
  private ranged: RangeAim | null = null;
  private readonly rangeAim: RangeAim = { eye: new Vector3(), radius: 0, ramp: 0, survivors: false };
  /** The last view `update` selected for, for `levelOf`, once there was one. */
  private readonly last: Aim = { eye: new Vector3(), scale: 0, ortho: false, fades: false, forced: null, frustum: new Frustum() };
  private selected = false;
  /** The shadow map `update` last selected for. */
  private readonly shadowView: Aim = { eye: new Vector3(), scale: 0, ortho: true, fades: false, forced: null, frustum: new Frustum() };

  /** `levels[0]` is the source. Empty only as the target of `copy`. It holds no instances until chunks are added. */
  constructor(levels: readonly LodLevel[] = [], options: LodOptions = {}) {
    super("InstancedLod", options);
    this.store = new Store();
    this.probes = new Probes(this.store, this.extent.rest);
    this.draws = levels.length > 0 ? this.build(levels) : 0;
    this.blocks = this.makeBlocks();
  }

  /** Instances in its chunks. */
  get count(): number {
    return this.store.count;
  }

  /** Its chunks, in the order they were added. */
  get chunks(): ReadonlySet<InstancedChunk> {
    return this.store.chunks;
  }

  /**
   * Add `data`'s instances as one chunk: instance `i` of it is instance `chunk.start + i` of this InstancedLod until the
   * chunk is removed. Adding and removing chunks costs about what they hold, a few per frame included.
   */
  addChunk(data: ChunkData): InstancedChunk {
    const { capacity, colors } = this.store;
    const chunk = this.store.add(data);
    this.fit(capacity, colors);
    return chunk;
  }

  /** Remove `chunk`'s instances; its indices may go to a chunk added later. */
  removeChunk(chunk: InstancedChunk): void {
    const { capacity, colors } = this.store;
    this.store.remove(chunk);
    this.fit(capacity, colors);
  }

  /** Follow the store to a new capacity, or to colours it has begun to carry. */
  private fit(capacity: number, colors: Float32Array | null): void {
    const { store } = this;
    if (store.capacity !== capacity) {
      this.blocks = this.makeBlocks();
      this.selection?.resize(store);
    }
    if (store.capacity !== capacity || store.colors !== colors) this.meshes?.rebind();
  }

  private makeBlocks(): Blocks {
    const { store } = this;
    const survivors = this.ranged?.survivors ? store.keeps : null;
    const blocks = new Blocks(store.capacity, store.spheres, this.extent.source, this.bounds, this.draws, this.extent.rest, survivors);
    blocks.pad(this.padding);
    return blocks;
  }

  private build(inputs: readonly LodLevel[]): number {
    const { extent } = this;
    inputs.forEach((input, i) => this.entries.push(new Level(input, i, this.entries)));
    estimate(this.entries, 2 * extent.measure(inputs));
    validate(this.entries);
    this.residency.reset();
    const templates = this.entries.map(({ object }, i) => (object ? parts(object, i) : []));
    this.probes.add(templates[0] ?? []);
    const draws = templates.flatMap((parts) => parts.map((part) => part.draw));
    const selection = new Selection(
      this.store,
      extent.source,
      templates.map((parts, i) => parts.length > 0 || at(inputs, i).box?.isEmpty() === false),
      draws,
      this.residency.fallback,
    );
    selection.reach.value = extent.rest.radius;
    selection.end = this.store.end;
    this.selection = selection;
    this.store.attach(selection);
    const meshes = new Meshes(selection, extent.reaches, extent.drawRadius, {
      live: () => !this.disposed,
      drawn: (camera, mesh) => this.residency.drawn(camera, mesh),
      guard: (action) => this.residency.guard(action),
    });
    this.meshes = meshes;
    for (const mesh of meshes.fill(this.entries, templates)) this.add(mesh);
    return draws.length;
  }

  protected override arrived(): void {
    this.selection?.route(this.residency.fallback, this.residency.progress < 1);
    super.arrived();
  }

  /** Compile only the arriving level; bounds and instance buffers stay fixed. */
  protected async install(level: Level, template: Object3D, context: RenderContext): Promise<void> {
    if (!this.meshes) throw new Error("InstancedLod: missing selection");
    const loaded = await this.meshes.load(level, template, async (staged) => {
      refreshWind(this, staged);
      await compileLevel(staged, context);
    });
    if (!loaded) return;
    level.object = loaded.object;
    if (level.index === 0) this.probes.add(loaded.found);
    for (const mesh of loaded.made) this.add(mesh);
  }

  /** Move instance `index`, an instance of one of its chunks. */
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
    if (first) this.meshes?.rebind();
  }

  /** Instance `index`'s colour: white unless set. */
  getColorAt(index: number, color: Color): Color {
    return this.store.getColor(index, color);
  }

  /**
   * The finest level instance `index` drew in the last update, or null before the first
   * (or at scale 0, or out of range). Inside a fade the next coarser level draws too.
   */
  levelOf(index: number): number | null {
    const { last, store, ranged } = this;
    store.check(index);
    if (!this.selected) return null;
    store.measure(this.blocks);
    let height = store.height(index, last);
    if (height === null) return null;
    if (ranged) {
      const kept = keptFraction(origin.fromArray(store.matrices, index * 16 + 12).distanceTo(ranged.eye), ranged);
      if (at(store.keeps, index) >= kept) return null;
      if (ranged.survivors) height *= survivorScale(kept);
    }
    const level = levelAt(this.entries, height, last.forced);
    const selected = last.fades && fadeProgress(this.entries, level, height) > 0 ? level.index - 1 : level.index;
    const ready = at(this.residency.fallback, selected);
    return ready < 0 ? null : ready;
  }

  protected sway(padding: number, slope: number, baseY: number): void {
    const sway = this.extent.wind(padding, slope, baseY);
    this.meshes?.setRadius(this.extent.drawRadius);
    this.padding = sway;
    this.blocks.pad(sway);
    this.blocks.refit();
    if (this.selection) this.selection.reach.value = this.extent.rest.radius * (1 + sway);
  }

  /** Sort instances for `camera`, a view or a shadow map's. */
  protected pick(camera: Camera): void {
    if (this.disposed) return;
    const { entries, selection, meshes, residency } = this;
    if (!selection || !meshes) return;
    validate(entries);
    if (this.forceLevel !== null && !entries[this.forceLevel]) throw new Error(`Lod: forceLevel ${this.forceLevel} is not a level`);
    this.aimRange(selection, meshes);
    this.store.measure(this.blocks);
    const height = viewportHeight(camera);
    view.begin(camera, height ?? TYPICAL_HEIGHT, this.forceLevel);
    const shadow = inShadowPass(this);
    const seen = sight(shadow ? this.shadowView : this.last, view, camera, this.matrixWorld, Lod.quality, this.forceLevel);
    const drawn = this.blocks.select(entries, seen, this.extent.reaches, height !== null, this.matrixWorld);
    const progress = residency.progress;
    if (selection.progress.value !== progress) {
      selection.progress.value = progress;
      selection.changed();
    }
    this.demandLevels(camera, drawn, shadow);
    this.extent.reroute(residency.fallback, residency.previous, progress);
    // Cameras that stopped rendering it, as a clone made for one frame does, give their slots back.
    selection.forget((other) => other === camera || residency.viewing(other));
    selection.aim(camera, seen, entries);
    // Selected only when something may draw: an InstancedLod with every level hidden
    // keeps its last selection.
    const shown = meshes.show(camera, this.matrixWorld);
    meshes.schedule(shown);
    if (!shadow) this.showContacts(selection, meshes, shown);
    residency.sync();
  }

  /** Select and draw the current `contact`s for a view, in which something may draw if `shown`. */
  private showContacts(selection: Selection, meshes: Meshes, shown: boolean): void {
    const { contact } = this;
    if (contact) checkContact(contact);
    selection.contact(contact && contact.distance / this.matrixWorld.getMaxScaleOnAxis());
    const mesh = meshes.useContacts(contact !== null);
    if (!mesh || !contact) return;
    if (mesh.parent !== this) this.add(mesh);
    mesh.contact = contact;
    // Its draws are as current as the levels': stale while nothing may draw.
    mesh.visible = shown;
  }

  /** Select every view with the current `range`, measured from its camera, in this crowd's space. */
  private aimRange(selection: Selection, meshes: Meshes): void {
    const { range } = this;
    const survived = this.ranged?.survivors ?? false;
    this.ranged = null;
    if (range) {
      checkRange(range);
      const aim = this.rangeAim;
      const scale = this.matrixWorld.getMaxScaleOnAxis();
      aim.eye.setFromMatrixPosition(range.camera.matrixWorld).applyMatrix4(inverse.copy(this.matrixWorld).invert());
      aim.radius = range.radius / scale;
      aim.ramp = range.ramp / scale;
      aim.survivors = range.scaleSurvivors ?? false;
      this.ranged = aim;
    }
    selection.range(this.ranged);
    if ((this.ranged?.survivors ?? false) === survived) return;
    // Survivors draw larger than the blocks bounded them, or no longer do.
    this.blocks = this.makeBlocks();
    this.blocks.measure(this.store.matrices, 0, this.store.end);
    this.blocks.refit();
    meshes.rebind();
  }

  /**
   * Ask for the levels `drawn` for `camera`, a view's or a shadow map's: every view demands what it draws. They install
   * as they arrive, from a view's render context.
   */
  private demandLevels(camera: Camera, drawn: number[], shadow: boolean): void {
    const { entries, meshes, residency } = this;
    if (!meshes) return;
    tintLevels(entries, Lod.debug);
    if (!shadow) this.selected = true;
    // Reusable crowds can be populated and drawn in the same frame.
    const needed = this.bounds.isEmpty() ? entries.flatMap((level) => (level.object ? [level.index] : [])) : drawn;
    residency.demand(camera, needed);
    residency.update(camera, meshes.byLevel);
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
   * Copies `source`'s levels, chunks and settings into this empty InstancedLod, one without levels or chunks (it throws
   * otherwise); the copy shares geometry and textures with `source`. Its chunks are its own, at the same indices.
   */
  override copy(source: InstancedLod): this {
    if (this.entries.length > 0 || this.store.chunks.size > 0) throw new Error("InstancedLod.copy: copy into an InstancedLod without levels or chunks");
    super.copy(source, false);
    this.store.copy(source.store);
    this.range = source.range && { ...source.range };
    this.contact = source.contact && { ...source.contact };
    this.draws = source.entries.length > 0 ? this.build(cloneLevels(source.entries)) : 0;
    this.blocks = this.makeBlocks();
    this.copySettings(source);
    return this;
  }

  override clone(): this {
    const clone = new InstancedLod().copy(this);
    if (!sameClass(this, clone)) throw new Error("InstancedLod.clone: a subclass must override clone");
    return clone;
  }

  protected release(): void {
    this.meshes?.dispose();
    this.selection?.dispose();
    this.store.attach(null);
    for (const { object } of this.entries) if (object) disposeCopies(object);
  }
}
